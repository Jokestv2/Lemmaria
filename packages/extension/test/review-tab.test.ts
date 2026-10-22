// U5 manual-test round 2: the Review surface is a TAB inside the Assistant
// webview (next to Assistant / Citations / Models / Venue), not a separate
// view. These tests drive the host seams (the U1-U4 tab pattern); tab pixels
// are covered by the manual checklist (ADR 0001: no browser test runner).
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface ReviewAnnotationInfo {
  index: number;
  dimension: string;
  severity: string;
  message: string;
  reviewer: string;
  line: number;
  hasSuggestion: boolean;
  suggestion?: string;
  status: string; // "pending" | "accepted" | "ignored" (round 3)
}
interface ReviewTabState {
  available: boolean;
  file: string;
  annotations: ReviewAnnotationInfo[];
}
interface AdoptOutcome {
  status: string;
  message?: string;
  virtualUri?: vscode.Uri;
}
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
  lastReviewTabStateForTests(): ReviewTabState | undefined;
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}
  generate(_req: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve({
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

const DOC = [
  "\\documentclass{article}", // line 1
  "\\begin{document}", // 2
  "\\section{Intro}", // 3
  "", // 4
  "Attention mechanisms is very useful for modeling.", // 5
  "", // 6
  "They has been adopted widely.", // 7
  "", // 8
  "\\end{document}", // 9
  "",
].join("\n");

const ANSWER = JSON.stringify({
  annotations: [
    {
      dimension: "language",
      severity: "minor",
      anchor: "mechanisms is very useful",
      message: "Subject–verb agreement.",
    },
    {
      dimension: "language",
      severity: "major",
      anchor: "They has been adopted",
      message: "Subject–verb agreement.",
      suggestion: "They have been adopted",
    },
  ],
});

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

/** A UNIQUE basename per call: review state is window-global in the shared
 *  extension host, so only a unique file name proves an assertion saw THIS
 *  test's review (not leftovers from an earlier suite/test). */
async function reviewFixture(api: LemmariaApi): Promise<vscode.Uri> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(os.tmpdir(), `lemmaria-u5r-${stamp}`);
  const uri = vscode.Uri.file(path.join(dir, `paper-${stamp}.tex`));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(DOC.indexOf("Attention"));
  const end = doc.positionAt(DOC.indexOf("widely.") + "widely.".length);
  editor.selection = new vscode.Selection(start, end);
  const outcome = (await vscode.commands.executeCommand("lemmaria.review")) as {
    status: string;
    message?: string;
  };
  assert.strictEqual(outcome.status, "reviewed", outcome.message);
  return uri;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await delay(50);
  }
  return pred();
}

suite("U5 round 2: the Review tab (webview) host seams", function () {
  this.timeout(20000);

  test("the manifest contributes NO lemmariaReview view — Review is a webview tab", async () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext);
    const contributes = (
      ext.packageJSON as {
        contributes: {
          views: Record<string, { id: string }[]>;
          viewsWelcome?: { view: string }[];
          menus?: Record<string, { when?: string }[]>;
        };
      }
    ).contributes;
    for (const [container, views] of Object.entries(contributes.views)) {
      assert.ok(
        !views.some((v) => v.id === "lemmariaReview"),
        `lemmariaReview still contributed in ${container}`,
      );
    }
    assert.ok(
      !(contributes.viewsWelcome ?? []).some(
        (w) => w.view === "lemmariaReview",
      ),
      "stale lemmariaReview viewsWelcome entry",
    );
    for (const [menu, entries] of Object.entries(contributes.menus ?? {})) {
      assert.ok(
        !entries.some((e) => e.when?.includes("lemmariaReview")),
        `stale lemmariaReview menu entry in ${menu}`,
      );
    }
  });

  test("requestReview returns the last review's annotations for the tab", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      const state = (await api.dispatchWebviewMessageForTests({
        type: "requestReview",
      })) as ReviewTabState;
      assert.ok(state, "requestReview returned nothing");
      assert.strictEqual(state.available, true);
      assert.strictEqual(state.file, path.basename(uri.fsPath));
      assert.strictEqual(state.annotations.length, 2);
      const [a0, a1] = state.annotations;
      assert.strictEqual(a0?.index, 0);
      assert.strictEqual(a0?.line, 5);
      assert.strictEqual(a0?.severity, "minor");
      assert.strictEqual(a0?.hasSuggestion, false);
      assert.strictEqual(a1?.index, 1);
      assert.strictEqual(a1?.line, 7);
      assert.strictEqual(a1?.hasSuggestion, true);
      assert.strictEqual(a1?.suggestion, "They have been adopted");
    } finally {
      api.clearModelForTests();
    }
  });

  test("a completed review pushes the tab state to the webview host-side", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      // The push happens as part of the review command (host-initiated
      // reveal), WITHOUT the tab asking first. It is async (the host awaits
      // the webview's ready) — poll for THIS review's unique file so leftover
      // state from earlier suites can never satisfy the assertion.
      const expected = path.basename(uri.fsPath);
      const pushed = await waitFor(
        () => api.lastReviewTabStateForTests()?.file === expected,
      );
      assert.ok(
        pushed,
        `review completion did not push the tab state for ${expected}; last=${JSON.stringify(
          api.lastReviewTabStateForTests(),
        )}`,
      );
      assert.strictEqual(api.lastReviewTabStateForTests()?.available, true);
      assert.strictEqual(
        api.lastReviewTabStateForTests()?.annotations.length,
        2,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("revealAnnotation from the tab jumps the editor to the annotation's line", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      await api.dispatchWebviewMessageForTests({
        type: "revealAnnotation",
        index: 1,
      });
      const editor = vscode.window.activeTextEditor;
      assert.strictEqual(editor?.document.uri.fsPath, uri.fsPath);
      assert.strictEqual(editor?.selection.start.line, 6); // line 7, 0-based
    } finally {
      api.clearModelForTests();
    }
  });

  test("adoptSuggestion from the tab enters the Accept-gated diff", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      const adopt = (await api.dispatchWebviewMessageForTests({
        type: "adoptSuggestion",
        index: 1,
      })) as AdoptOutcome;
      assert.strictEqual(adopt.status, "proposed", adopt.message);
      assert.ok(adopt.virtualUri, "no diff opened");
      // Reject (returns void) — invariant 3: nothing lands without Accept.
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        adopt.virtualUri,
      );
      const onDisk = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(onDisk, DOC, "reject must leave the file untouched");
    } finally {
      api.clearModelForTests();
    }
  });

  // ---- Round 3 (operator feedback): each finding carries a triage status —
  // pending until the user adopts it (→ accepted) or ignores it (→ ignored) —
  // and the webview groups accepted/ignored into folded sub-lists. ----

  test("findings start pending; ignoreAnnotation moves one to ignored", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      await reviewFixture(api);
      const before = (await api.dispatchWebviewMessageForTests({
        type: "requestReview",
      })) as ReviewTabState;
      assert.strictEqual(before.annotations[0]?.status, "pending");
      assert.strictEqual(before.annotations[1]?.status, "pending");

      const after = (await api.dispatchWebviewMessageForTests({
        type: "ignoreAnnotation",
        index: 0,
      })) as ReviewTabState;
      assert.strictEqual(
        after.annotations[0]?.status,
        "ignored",
        "index 0 should move to ignored",
      );
      assert.strictEqual(
        after.annotations[1]?.status,
        "pending",
        "index 1 must be untouched",
      );
      // The host caches the new state so the tab renders it on re-open.
      assert.strictEqual(
        api.lastReviewTabStateForTests()?.annotations[0]?.status,
        "ignored",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("accepting an adopted suggestion flips its finding to accepted", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      const adopt = (await api.dispatchWebviewMessageForTests({
        type: "adoptSuggestion",
        index: 1,
      })) as AdoptOutcome;
      assert.strictEqual(adopt.status, "proposed", adopt.message);
      assert.ok(adopt.virtualUri, "no diff opened");

      // Accept the diff exactly as the M4 flow does — the proposal-accepted
      // event correlates the landed edit back to annotation 1 and re-pushes.
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        adopt.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");

      const expected = path.basename(uri.fsPath);
      const flipped = await waitFor(() => {
        const st = api.lastReviewTabStateForTests();
        return (
          st?.file === expected && st.annotations[1]?.status === "accepted"
        );
      });
      assert.ok(
        flipped,
        `annotation 1 never became accepted; last=${JSON.stringify(
          api.lastReviewTabStateForTests(),
        )}`,
      );
      assert.strictEqual(
        api.lastReviewTabStateForTests()?.annotations[0]?.status,
        "pending",
        "an unrelated finding must stay pending",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a stale-diff Accept after re-running Review does not flip a fresh finding", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const uri = await reviewFixture(api);
      // Adopt finding 1 (opens the diff) but do NOT accept yet.
      const adopt = (await api.dispatchWebviewMessageForTests({
        type: "adoptSuggestion",
        index: 1,
      })) as AdoptOutcome;
      assert.strictEqual(adopt.status, "proposed", adopt.message);

      // Re-run Review on the SAME file — a brand-new generation of findings,
      // all pending. The correlation must be scoped to the generation the user
      // actually adopted in, not merely "some pending finding with this text".
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const start = doc.positionAt(DOC.indexOf("Attention"));
      const end = doc.positionAt(DOC.indexOf("widely.") + "widely.".length);
      editor.selection = new vscode.Selection(start, end);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as { status: string; message?: string };
      assert.strictEqual(outcome.status, "reviewed", outcome.message);

      // Accept the STALE diff from the FIRST review. The edit landing is fine,
      // but finding 1 of the FRESH review was never adopted → must stay pending.
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        adopt.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");

      const expected = path.basename(uri.fsPath);
      await waitFor(() => api.lastReviewTabStateForTests()?.file === expected);
      await delay(200); // let any (wrong) async flip land before asserting absence
      const st = api.lastReviewTabStateForTests();
      assert.strictEqual(st?.file, expected);
      assert.strictEqual(
        st?.annotations[1]?.status,
        "pending",
        "a stale-diff accept must not flip the fresh review's finding",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
