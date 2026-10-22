// X1 acceptance suite: Compile Check lists every finding, the user triages each
// one, and a Fix routes through the Accept-gated diff — nothing auto-runs.
// Drives the REAL bundled extension with a deterministic in-test model + a fake
// compile (the ext-host runner has no TeX), both injected through the exports API.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CompileProjectOptions,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface CompileFindingInfo {
  index: number;
  severity: string;
  code: string;
  message: string;
  line?: number;
  status: string; // "pending" | "fixed" | "ignored"
}
interface CompileTabState {
  available: boolean;
  file: string;
  ok: boolean;
  findings: CompileFindingInfo[];
  guidance?: string;
}
interface FixOutcome {
  status: string;
  message?: string;
  virtualUri?: vscode.Uri;
}
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>,
  ): void;
  clearCompileForTests(): void;
  setEngineProbeForTests(fn: (engine: string) => boolean): void;
  clearEngineProbeForTests(): void;
  compileTabStateForTests(): CompileTabState;
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
  lastCompileTabStateForTests(): CompileTabState | undefined;
  setProgressRunnerForTests(
    runner?: <T>(
      options: vscode.ProgressOptions,
      task: () => Promise<T>,
    ) => Promise<T>,
  ): void;
}

/** Records every request so a test can assert what the fix prompt carried. */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly texts: string[]) {}
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = this.texts[Math.min(this.i, this.texts.length - 1)] ?? "";
    this.i += 1;
    return Promise.resolve({
      text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
  /** Every prompt text this model was ever sent, concatenated. */
  promptText(): string {
    return this.requests
      .flatMap((r) => r.messages.map((m) => JSON.stringify(m.content)))
      .join("\n");
  }
}

// A failing compile with TWO findings: an error (line 4) and a warning (line 6).
const TWO_FINDING_LOG = [
  "! Undefined control sequence.",
  "l.4 \\docuent",
  "               {intro}",
  "LaTeX Warning: Reference `fig:one' undefined on input line 6.",
  "",
].join("\n");
// A clean-but-warned compile with ONE finding.
const ONE_FINDING_LOG =
  "\nOverfull \\hbox (300.0pt too wide) in paragraph at lines 6--6\n";
// A failing compile with TWELVE findings (one per distinct undefined
// reference, so none collapse under compile-log.ts's id dedup) — more than
// MAX_FIX_WARNINGS (8), to pin Finding 1: Fix all must only flip the rows
// actually sent to the model, not every pending row.
const MANY_FINDING_LOG = Array.from(
  { length: 12 },
  (_, i) =>
    `LaTeX Warning: Reference \`fig:${i}' undefined on input line ${i + 10}.`,
).join("\n");

function fixedLog(ok: boolean, log: string) {
  return (
    opts: CompileProjectOptions,
  ): Promise<{ ok: boolean; log: string }> => {
    void opts;
    return Promise.resolve({ ok, log });
  };
}

const DEFECT = "\\docuent{intro}";
const DOC = [
  "\\documentclass{article}",
  "\\begin{document}",
  "",
  DEFECT,
  "",
  "A perfectly ordinary paragraph about attention.",
  "",
  "\\end{document}",
  "",
].join("\n");
/** The model's fix answer for `\docuent{intro}` (replace_anchor, ADR 0007). */
const FIX_ANSWER = JSON.stringify({
  anchor: DEFECT,
  replacement: "\\section{intro}",
});

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

/** A UNIQUE basename per call: the compile tab's state is window-global in the
 *  shared extension host, so only a unique file name proves an assertion saw
 *  THIS test's Compile Check (not leftovers from an earlier test/suite). */
async function makePaper(): Promise<vscode.Uri> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(os.tmpdir(), `lemmaria-x1c-${stamp}`);
  const uri = vscode.Uri.file(path.join(dir, `paper-${stamp}.tex`));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  return uri;
}

/** Focus the paper (verifyNow reads the ACTIVE editor) and run Compile Check. */
async function compileCheck(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(uri),
  );
  await vscode.commands.executeCommand("lemmaria.verifyNow");
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

suite("Compile tab (X1)", function () {
  this.timeout(30000);

  test("Compile Check lists every finding, all pending", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.available, true);
      assert.strictEqual(state.file, path.basename(uri.fsPath));
      assert.strictEqual(state.ok, false, "the compile failed — say so");
      assert.strictEqual(state.findings.length, 2);
      assert.ok(state.findings.every((f) => f.status === "pending"));
      assert.deepStrictEqual(
        state.findings.map((f) => f.index),
        [0, 1],
      );
      assert.strictEqual(state.findings[0]?.code, "undefined-control-sequence");
      assert.strictEqual(state.findings[0]?.severity, "error");
      assert.strictEqual(state.findings[0]?.line, 4);
      assert.strictEqual(state.findings[1]?.code, "undefined-ref");
      assert.strictEqual(state.findings[1]?.severity, "warning");
      assert.strictEqual(state.findings[1]?.line, 6);
      assert.strictEqual(state.guidance, undefined, "the engine was available");
    } finally {
      api.clearCompileForTests();
    }
  });

  test("a second Compile Check replaces the first run's findings", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      assert.strictEqual(api.compileTabStateForTests().findings.length, 2);

      api.setCompileForTests(fixedLog(true, ONE_FINDING_LOG));
      await compileCheck(uri);
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.findings.length, 1);
      assert.strictEqual(state.findings[0]?.code, "overfull-hbox");
      assert.strictEqual(
        state.ok,
        true,
        "ok: a compile can succeed WITH warnings",
      );
      assert.strictEqual(state.findings[0]?.status, "pending");
    } finally {
      api.clearCompileForTests();
    }
  });

  test("Fix on a row proposes an edit through the Accept-gated diff", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    api.setModelForTests(new TestModel([FIX_ANSWER]));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixFinding",
        0,
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      // Invariant 3: proposed, NOT written.
      assert.ok(
        outcome.virtualUri,
        "a fix must land in a diff, never a silent write",
      );
      const onDisk = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(
        onDisk,
        DOC,
        "the fix must not touch the file before Accept",
      );
      // The row is untouched until the diff is Accepted.
      assert.strictEqual(
        api.compileTabStateForTests().findings[0]?.status,
        "pending",
      );
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
      const afterReject = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(
        afterReject,
        DOC,
        "reject must leave the file untouched",
      );
      assert.strictEqual(
        api.compileTabStateForTests().findings[0]?.status,
        "pending",
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("Accepting a fix flips exactly that row and compiles nothing", async () => {
    const api = await getApi();
    let compiles = 0;
    const compile = fixedLog(false, TWO_FINDING_LOG);
    api.setCompileForTests((opts) => {
      compiles += 1;
      return compile(opts);
    });
    api.setModelForTests(new TestModel([FIX_ANSWER]));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      assert.strictEqual(
        compiles,
        1,
        "Compile Check compiles once, when asked",
      );

      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixFinding",
        0,
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");

      const flipped = await waitFor(
        () => api.compileTabStateForTests().findings[0]?.status === "fixed",
      );
      const state = api.compileTabStateForTests();
      assert.ok(
        flipped,
        `row 0 never became fixed; last=${JSON.stringify(state)}`,
      );
      assert.strictEqual(
        state.findings[1]?.status,
        "pending",
        "a sibling must not flip",
      );
      // The edit landed (Accept writes) — but nothing re-ran on its own.
      const onDisk = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.ok(
        onDisk.includes("\\section{intro}"),
        "the accepted fix was not written",
      );
      // X1: the whole point. Wait past any surviving debounce window.
      await delay(2000);
      assert.strictEqual(compiles, 1, "Accepting a fix must not re-compile");
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("a Compile Check between Fix and Accept does not mis-flip a fresh finding", async () => {
    // The generation guard (review-ui's pendingAdoptions lesson): the accept
    // correlation is scoped to the compile the user actually Fixed in, not
    // merely "some pending row of the current run".
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    api.setModelForTests(new TestModel([FIX_ANSWER]));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixFinding",
        0,
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);

      // Re-run Compile Check — a brand-new generation of findings, all pending.
      await compileCheck(uri);
      assert.ok(
        api
          .compileTabStateForTests()
          .findings.every((f) => f.status === "pending"),
      );

      // Accept the STALE diff from the FIRST run. The edit landing is fine, but
      // no row of the FRESH run was ever Fixed → nothing may flip.
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");
      await delay(300); // let any (wrong) async flip land before asserting absence
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.findings.length, 2);
      assert.ok(
        state.findings.every((f) => f.status === "pending"),
        `a stale-diff accept must not flip a fresh finding; last=${JSON.stringify(state)}`,
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("a Polish accept on the same file does not mis-flip a stale rejected fix (action-name gate)", async () => {
    // Task 4 deliberately drops review-ui.ts's span guard (fix-compile-error
    // emits replace_anchor and picks its own span, so the caller can't predict
    // it) — the action-name gate plus the generation check are the ENTIRE
    // correlation defense. This is the scenario where the generation check does
    // NOT fire: Reject leaves a stale pendingFixes entry (by design — cleared
    // only on a matching Accept), no fresh Compile Check runs before the Polish
    // accept, so `pend.compile === state` still holds. Only the action-name
    // gate protects row 0 here.
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    api.setModelForTests(
      new TestModel([FIX_ANSWER, "A polished paragraph about attention."]),
    );
    try {
      const uri = await makePaper();
      await compileCheck(uri);

      const fixOutcome = (await vscode.commands.executeCommand(
        "lemmaria.fixFinding",
        0,
      )) as FixOutcome;
      assert.strictEqual(fixOutcome.status, "proposed", fixOutcome.message);
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        fixOutcome.virtualUri,
      );
      assert.strictEqual(
        api.compileTabStateForTests().findings[0]?.status,
        "pending",
        "reject must leave the row pending",
      );

      // Polish an UNRELATED paragraph in the same file and Accept it — a
      // completely different action, routed through the same Accept-gated diff.
      const para = "A perfectly ordinary paragraph about attention.";
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const start = DOC.indexOf(para);
      editor.selection = new vscode.Selection(
        doc.positionAt(start),
        doc.positionAt(start + para.length),
      );
      const polishOutcome = (await vscode.commands.executeCommand(
        "lemmaria.polish",
      )) as { status: string; message?: string; virtualUri?: vscode.Uri };
      assert.strictEqual(
        polishOutcome.status,
        "proposed",
        polishOutcome.message,
      );
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        polishOutcome.virtualUri,
      );
      assert.strictEqual(accepted, true, "polish accept failed");

      // Give any (wrong) async flip time to land before asserting its absence.
      await delay(300);
      const state = api.compileTabStateForTests();
      assert.strictEqual(
        state.findings[0]?.status,
        "pending",
        `an unrelated Polish accept must not flip a compile finding; last=${JSON.stringify(state)}`,
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("Ignore moves a row to ignored without proposing anything", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    // No model: Ignore must never reach one.
    api.clearModelForTests();
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      await vscode.commands.executeCommand("lemmaria.ignoreFinding", 1);
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.findings[1]?.status, "ignored");
      assert.strictEqual(
        state.findings[0]?.status,
        "pending",
        "a sibling must not move",
      );
      const onDisk = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(
        onDisk,
        DOC,
        "Ignore is triage state — it never edits",
      );
    } finally {
      api.clearCompileForTests();
    }
  });

  test("Fix all proposes one edit carrying every pending finding", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    const model = new TestModel([FIX_ANSWER]);
    api.setModelForTests(model);
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixAllFindings",
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri, "Fix all must land in a diff too");
      // ONE request, carrying BOTH findings (formatWarningsForFix, Task 1).
      const prompt = model.promptText();
      assert.ok(
        prompt.includes("undefined-control-sequence"),
        "the fix request dropped finding 0",
      );
      assert.ok(
        prompt.includes("undefined-ref"),
        "the fix request dropped finding 1",
      );
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("Fix all skips ignored rows", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    const model = new TestModel([FIX_ANSWER]);
    api.setModelForTests(model);
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      await vscode.commands.executeCommand("lemmaria.ignoreFinding", 1);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixAllFindings",
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      const prompt = model.promptText();
      assert.ok(prompt.includes("undefined-control-sequence"));
      assert.ok(
        !prompt.includes("undefined-ref"),
        "an ignored finding must not be sent for fixing",
      );
      // Accepting flips only the row that was actually routed into the diff.
      await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      await waitFor(
        () => api.compileTabStateForTests().findings[0]?.status === "fixed",
      );
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.findings[0]?.status, "fixed");
      assert.strictEqual(state.findings[1]?.status, "ignored");
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("Fix all with more pending findings than the model was shown flips only those rows", async () => {
    // Finding 1: formatWarningsForFix truncates to MAX_FIX_WARNINGS (8). With
    // 12 pending findings, fixAllFindings must route (and later flip) only the
    // 8 the model actually saw — the other 4 must stay pending on Accept.
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, MANY_FINDING_LOG));
    const model = new TestModel([FIX_ANSWER]);
    api.setModelForTests(model);
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      assert.strictEqual(api.compileTabStateForTests().findings.length, 12);

      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.fixAllFindings",
      )) as FixOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      const prompt = model.promptText();
      assert.ok(prompt.includes("fig:7"), "the fix request dropped finding 7");
      assert.ok(
        !prompt.includes("fig:8"),
        "the fix request must cap at MAX_FIX_WARNINGS (8) — finding 8 was not shown to the model",
      );

      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");

      await waitFor(
        () => api.compileTabStateForTests().findings[0]?.status === "fixed",
      );
      const state = api.compileTabStateForTests();
      for (let i = 0; i < 8; i++) {
        assert.strictEqual(
          state.findings[i]?.status,
          "fixed",
          `row ${i} was sent to the model and must flip to fixed`,
        );
      }
      for (let i = 8; i < 12; i++) {
        assert.strictEqual(
          state.findings[i]?.status,
          "pending",
          `row ${i} was never shown to the model and must stay pending`,
        );
      }
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("no engine → an honest guidance state, not an empty list", async () => {
    const api = await getApi();
    // resolveEngine's tectonic-absent path: no engine is on PATH.
    api.setEngineProbeForTests(() => false);
    api.setCompileForTests(fixedLog(true, ""));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const state = api.compileTabStateForTests();
      assert.strictEqual(state.available, true);
      assert.strictEqual(state.findings.length, 0);
      assert.ok(
        state.guidance && state.guidance.length > 0,
        "no engine must read as guidance, never as a clean bill of health",
      );
      assert.match(state.guidance ?? "", /tectonic/);
    } finally {
      api.clearEngineProbeForTests();
      api.clearCompileForTests();
    }
  });

  // ---- The webview host seams (the U1-U5 tab pattern). ----

  test("requestCompile returns the last Compile Check's findings for the tab", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      const state = (await api.dispatchWebviewMessageForTests({
        type: "requestCompile",
      })) as CompileTabState;
      assert.ok(state, "requestCompile returned nothing");
      assert.strictEqual(state.file, path.basename(uri.fsPath));
      assert.strictEqual(state.findings.length, 2);
      // A completed Compile Check also pushes the tab state (host-initiated).
      const pushed = await waitFor(
        () =>
          api.lastCompileTabStateForTests()?.file === path.basename(uri.fsPath),
      );
      assert.ok(pushed, "Compile Check did not push the tab state");
    } finally {
      api.clearCompileForTests();
    }
  });

  test("revealFinding from the tab jumps the editor to the finding's line", async () => {
    const api = await getApi();
    api.setCompileForTests(fixedLog(false, TWO_FINDING_LOG));
    try {
      const uri = await makePaper();
      await compileCheck(uri);
      await api.dispatchWebviewMessageForTests({
        type: "revealFinding",
        index: 1,
      });
      const editor = vscode.window.activeTextEditor;
      assert.strictEqual(editor?.document.uri.fsPath, uri.fsPath);
      assert.strictEqual(editor?.selection.start.line, 5); // line 6, 0-based
    } finally {
      api.clearCompileForTests();
    }
  });
});

/**
 * D4 / CHROME-4: `Lemmaria: Compile Check` runs inside a foreground progress
 * notification. A full LaTeX compile can take tens of seconds, and until D4 the
 * only signal was a status-bar spinner.
 *
 * The runner is injected rather than mocked at the `vscode` level, so what is
 * asserted is HOW our code wraps the compile — the same shape as
 * `setCompileForTests` one layer down. In production the default runner is the
 * real `vscode.window.withProgress`.
 */
suite("D4: Compile Check reports progress", function () {
  this.timeout(30000);
  let api: LemmariaApi;

  suiteSetup(async () => {
    api = await getApi();
  });

  teardown(() => {
    api.setProgressRunnerForTests(undefined);
  });

  test("the compile runs inside a Notification progress scope", async () => {
    const seen: { location: unknown; cancellable?: boolean; title?: string }[] =
      [];
    let compiledInsideScope = false;
    let insideScope = false;
    api.setProgressRunnerForTests(async (options, task) => {
      seen.push({
        location: options.location,
        cancellable: options.cancellable,
        title: options.title,
      });
      insideScope = true;
      try {
        return await task();
      } finally {
        insideScope = false;
      }
    });
    api.setCompileForTests(async () => {
      compiledInsideScope = insideScope;
      return { ok: true, log: "" };
    });

    await compileCheck(await makePaper());

    assert.strictEqual(seen.length, 1, "no progress scope was opened");
    assert.strictEqual(seen[0]?.location, vscode.ProgressLocation.Notification);
    assert.ok(
      compiledInsideScope,
      "the compile ran outside the progress scope",
    );
  });

  /**
   * `cancellable: false` is a DECISION, not an omission. A cancel is not
   * plumbable without widening the `Workspace.compile` contract, and a button
   * that abandoned the await while latexmk kept running to its 120 s timeout
   * would claim to have stopped something it did not. Pinned so a later change
   * has to argue with this comment.
   */
  test("it is deliberately NOT cancellable", async () => {
    const seen: (boolean | undefined)[] = [];
    api.setProgressRunnerForTests(async (options, task) => {
      seen.push(options.cancellable);
      return task();
    });
    api.setCompileForTests(async () => ({ ok: true, log: "" }));

    await compileCheck(await makePaper());

    assert.deepStrictEqual(seen, [false]);
  });
});
