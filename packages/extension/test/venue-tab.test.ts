// U4 acceptance surface: the Venue tab host seams. Rendering is covered by the
// manual checklist + the U0 round-trip + check:boundaries (ADR 0001: the
// browser bundle has no test runner).
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface VenueChecklistRowInfo {
  id: string;
  status: string;
  expected?: string;
  actual?: string;
  count?: number;
}

interface VenueState {
  available: boolean;
  file: string;
  detectedClass?: string;
  detectedOptions: string[];
  venue?: {
    id: string;
    label: string;
    engine: string;
    bibstyle?: string;
    anonymity?: string;
    pageLimit?: { value: number; unit: string; note?: string };
  };
  checklist: VenueChecklistRowInfo[];
}

interface VenueApi {
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
  computeVenueStateForTests(): Promise<VenueState>;
  lastVenueStateForTests(): VenueState | undefined;
  setCompileForTests(fn?: unknown): void;
  clearCompileForTests(): void;
  lastCompilePagesForTests(entryFsPath: string): number | undefined;
}

async function getApi(): Promise<VenueApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as VenueApi;
}

async function makeProject(
  mainTex: string,
  extra: Record<string, string> = {},
): Promise<vscode.Uri> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-u4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const main = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(main, Buffer.from(mainTex, "utf8"));
  for (const [name, content] of Object.entries(extra)) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(dir, name)),
      Buffer.from(content, "utf8"),
    );
  }
  const doc = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(doc);
  return main;
}

suite("U4 Venue tab — page recording", function () {
  this.timeout(30000);
  test("a verify compile records the entry's page count", async () => {
    const api = await getApi();
    const main = await makeProject(
      "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
    );
    api.setCompileForTests(async () => ({
      ok: true,
      log: "Output written on main.pdf (7 pages, 4242 bytes).\n",
    }));
    try {
      await vscode.commands.executeCommand("lemmaria.verifyNow");
      assert.strictEqual(api.lastCompilePagesForTests(main.fsPath), 7);
    } finally {
      api.clearCompileForTests();
    }
  });
});

const IEEE_MAIN = `\\documentclass[conference]{IEEEtran}
\\begin{document}
Real~\\cite{real2020} and ghost~\\cite{ghost2099}.
\\bibliographystyle{IEEEtran}
\\bibliography{refs}
\\end{document}
`;
const REFS = `@article{real2020, title = {A Real Paper}, year = {2019} }
`;

suite("U4 Venue tab — state", function () {
  this.timeout(30000);
  // Hermeticity: a developer's ~/.lemmaria/venues cache must not add venues
  // to the match set (the U0 venue-library lesson).
  suiteSetup(async () => {
    const cfg = vscode.workspace.getConfiguration("lemmaria.venues");
    await cfg.update(
      "cacheDir",
      path.join(os.tmpdir(), `lemmaria-u4-cache-${Date.now()}`),
      vscode.ConfigurationTarget.Global,
    );
  });
  suiteTeardown(async () => {
    const cfg = vscode.workspace.getConfiguration("lemmaria.venues");
    await cfg.update("cacheDir", undefined, vscode.ConfigurationTarget.Global);
  });

  test("resolves IEEEtran to ieee-conference with chips and an honest checklist", async () => {
    const api = await getApi();
    await makeProject(IEEE_MAIN, { "refs.bib": REFS });
    const state = (await api.dispatchWebviewMessageForTests({
      type: "requestVenue",
    })) as VenueState;
    assert.strictEqual(state.available, true);
    assert.strictEqual(state.detectedClass, "IEEEtran");
    assert.deepStrictEqual(state.detectedOptions, ["conference"]);
    assert.strictEqual(state.venue?.id, "ieee-conference");
    assert.strictEqual(state.venue?.engine, "pdflatex");
    assert.strictEqual(state.venue?.bibstyle, "IEEEtran");
    const byId = new Map(state.checklist.map((r) => [r.id, r]));
    assert.strictEqual(byId.get("anonymity")?.status, "pass"); // anonymity: none
    assert.strictEqual(byId.get("page_limit")?.status, "unknown"); // no limit declared
    assert.strictEqual(byId.get("bibstyle")?.status, "pass");
    assert.strictEqual(byId.get("citations")?.status, "fail"); // ghost2099 undefined
    assert.strictEqual(byId.get("citations")?.count, 1);
    // the dispatch also pushed/cached the state
    assert.deepStrictEqual(api.lastVenueStateForTests(), state);
  });

  test("acmart double-blind: fails without the anonymous option, passes with it", async () => {
    const api = await getApi();
    await makeProject(
      "\\documentclass[sigconf]{acmart}\n\\begin{document}\nHi\n\\end{document}\n",
    );
    let state = await api.computeVenueStateForTests();
    assert.strictEqual(state.venue?.id, "acm-sigconf");
    assert.strictEqual(
      state.checklist.find((r) => r.id === "anonymity")?.status,
      "fail",
    );
    await makeProject(
      "\\documentclass[sigconf,anonymous]{acmart}\n\\begin{document}\nHi\n\\end{document}\n",
    );
    state = await api.computeVenueStateForTests();
    assert.strictEqual(
      state.checklist.find((r) => r.id === "anonymity")?.status,
      "pass",
    );
  });

  test("an unknown class is honest: detected but no venue, empty checklist", async () => {
    const api = await getApi();
    await makeProject(
      "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
    );
    const state = await api.computeVenueStateForTests();
    assert.strictEqual(state.available, true);
    assert.strictEqual(state.detectedClass, "article");
    assert.strictEqual(state.venue, undefined);
    assert.deepStrictEqual(state.checklist, []);
  });

  test("no paper open → unavailable", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const state = await api.computeVenueStateForTests();
    assert.strictEqual(state.available, false);
  });

  test("newFromVenue routes to the existing command", async () => {
    const api = await getApi();
    const result = await api.dispatchWebviewMessageForTests({
      type: "newFromVenue",
    });
    assert.strictEqual(result, "lemmaria.newFromVenue");
    // dismiss the interactive venue QuickPick the fire-and-forget invocation opened
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  });
});
