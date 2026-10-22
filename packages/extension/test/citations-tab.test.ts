// U2 acceptance surface: the Citations tab wires the existing C1/C2 backend into
// the webview. These tests drive the HOST seams (the browser bundle has no test
// runner per ADR 0001); rendering is covered by the manual checklist + the U0
// round-trip + check:boundaries. C1 needs no TeX toolchain; C2 uses injected
// mock sources (the ext-host runner has no network).
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CitationMetadata,
  CitationQuery,
  CitationSource,
  Warning,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface CitationC1Result {
  available: boolean;
  root: string;
  entry: string;
  bibFiles: string[];
  entryCount: number;
  citedKeyCount: number;
  entryKeys: string[];
  entries: { key: string; fields: Record<string, string> }[];
  consistency: Warning[];
}

interface CitationsC2Display {
  status: string;
  results: {
    key: string;
    status: string;
    detail: string;
    hasCorrection: boolean;
  }[];
  endpoints: string[];
}

interface CitationsApi {
  setCitationSourcesForTests(sources: CitationSource[]): void;
  clearCitationSourcesForTests(): void;
  computeCitationC1ForTests(uri: vscode.Uri): Promise<CitationC1Result>;
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
  lastCitationsC2ForTests(): CitationsC2Display | undefined;
}

/** Poll `probe` until it returns a value or ~10s elapse. */
async function pollFor<T>(probe: () => T | undefined): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

function mockSource(
  name: CitationSource["name"],
  responder: (q: CitationQuery) => CitationMetadata | null,
): CitationSource {
  return {
    name,
    endpoint: `https://api.${name}.test`,
    lookup: (q) => Promise.resolve(responder(q)),
  };
}

// real2020 is cited AND defined; ghost2099 is cited but NOT defined (undefined-
// citation, error); orphan1999 is defined but NOT cited (orphan-citation, info).
const MAIN = `\\documentclass{article}
\\begin{document}
Real work~\\cite{real2020}, and a suspicious one~\\cite{ghost2099}.
\\bibliography{refs}
\\end{document}
`;
const REFS = `@article{real2020,
  title = {A Real Paper},
  year = {2019},
}
@article{orphan1999,
  title = {Never Cited},
  year = {1999},
}
`;

async function getApi(): Promise<CitationsApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as CitationsApi;
}

async function makeProject(): Promise<vscode.Uri> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-u2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const main = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(main, Buffer.from(MAIN, "utf8"));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(path.join(dir, "refs.bib")),
    Buffer.from(REFS, "utf8"),
  );
  return main;
}

suite("U2: computeCitationC1", function () {
  this.timeout(20000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("computes the bib header + C1 issues for the active paper", async () => {
    const api = await getApi();
    const uri = await makeProject();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const c1 = await api.computeCitationC1ForTests(uri);
    assert.strictEqual(c1.available, true);
    assert.deepStrictEqual(c1.bibFiles, ["refs.bib"]);
    assert.strictEqual(c1.entryCount, 2);
    assert.strictEqual(c1.citedKeyCount, 2); // real2020 + ghost2099
    assert.ok(
      c1.consistency.some((w) => w.code === "undefined-citation"),
      "expected undefined-citation for ghost2099",
    );
    assert.ok(
      c1.consistency.some((w) => w.code === "orphan-citation"),
      "expected orphan-citation for orphan1999",
    );
  });

  test("a non-tex/md uri → unavailable, empty", async () => {
    const api = await getApi();
    const c1 = await api.computeCitationC1ForTests(
      vscode.Uri.file(path.join(os.tmpdir(), "notes.txt")),
    );
    assert.strictEqual(c1.available, false);
    assert.deepStrictEqual(c1.consistency, []);
  });
});

suite("U2: requestCitations + revealCitation dispatch", function () {
  this.timeout(20000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("requestCitations returns C1 display state for the active paper", async () => {
    const api = await getApi();
    api.setCitationSourcesForTests([mockSource("crossref", () => null)]);
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const state = (await api.dispatchWebviewMessageForTests({
        type: "requestCitations",
      })) as {
        available: boolean;
        bibFiles: string[];
        entryKeys: string[];
        endpoints: string[];
        issues: { code: string; file: string; line: number }[];
      };
      assert.strictEqual(state.available, true);
      assert.deepStrictEqual(state.bibFiles, ["refs.bib"]);
      assert.deepStrictEqual(state.entryKeys.sort(), [
        "orphan1999",
        "real2020",
      ]);
      assert.ok(state.endpoints.some((e) => e.includes("crossref")));
      assert.ok(state.issues.some((i) => i.code === "undefined-citation"));
    } finally {
      api.clearCitationSourcesForTests();
    }
  });

  test("revealCitation opens the file at the issue line", async () => {
    const api = await getApi();
    const uri = await makeProject();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    // Populate the host's cached root.
    await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
    await api.dispatchWebviewMessageForTests({
      type: "revealCitation",
      file: "main.tex",
      line: 3,
    });
    const active = vscode.window.activeTextEditor;
    assert.ok(active?.document.fileName.endsWith("main.tex"));
    assert.strictEqual(active?.selection.active.line, 2); // 0-based
  });

  test("revealCitation jumps into the .bib for an orphan entry", async () => {
    const api = await getApi();
    const uri = await makeProject();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
    // orphan1999 is the second entry in refs.bib (line 5).
    await api.dispatchWebviewMessageForTests({
      type: "revealCitation",
      file: "refs.bib",
      line: 5,
    });
    const active = vscode.window.activeTextEditor;
    assert.ok(active?.document.fileName.endsWith("refs.bib"));
    assert.strictEqual(active?.selection.active.line, 4); // 0-based
  });
});

suite("U2: runCitationCheck + adoptCitation dispatch", function () {
  this.timeout(20000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("runCitationCheck returns per-key results with an adoptable mismatch", async () => {
    const api = await getApi();
    // real2020: bib year 2019, source says 2021 → metadata_mismatch + correction.
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") || q.doi ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
      const state = (await api.dispatchWebviewMessageForTests({
        type: "runCitationCheck",
      })) as {
        status: string;
        results: {
          key: string;
          status: string;
          detail: string;
          hasCorrection: boolean;
        }[];
        endpoints: string[];
      };
      assert.strictEqual(state.status, "checked");
      const real = state.results.find((r) => r.key === "real2020");
      assert.strictEqual(real?.status, "metadata_mismatch");
      assert.strictEqual(real?.hasCorrection, true);
      assert.ok(real?.detail.includes("→"), "detail shows the field change");
      assert.ok(state.endpoints.some((e) => e.includes("crossref")));
    } finally {
      api.clearCitationSourcesForTests();
    }
  });

  test("adoptCitation opens the Accept-gated diff; the .bib is untouched until Accept", async () => {
    const api = await getApi();
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") || q.doi ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const bibUri = vscode.Uri.file(
        path.join(path.dirname(uri.fsPath), "refs.bib"),
      );
      const before = Buffer.from(
        await vscode.workspace.fs.readFile(bibUri),
      ).toString();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
      await api.dispatchWebviewMessageForTests({ type: "runCitationCheck" });
      const diffUri = (await api.dispatchWebviewMessageForTests({
        type: "adoptCitation",
        key: "real2020",
      })) as vscode.Uri | undefined;
      assert.ok(diffUri, "a proposal diff should have opened");
      const after = Buffer.from(
        await vscode.workspace.fs.readFile(bibUri),
      ).toString();
      assert.strictEqual(after, before, "nothing written until Accept");
    } finally {
      api.clearCitationSourcesForTests();
    }
  });

  test("accepting an adopted correction re-checks that key and updates the tab state", async () => {
    const api = await getApi();
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const bibUri = vscode.Uri.file(
        path.join(path.dirname(uri.fsPath), "refs.bib"),
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
      await api.dispatchWebviewMessageForTests({ type: "runCitationCheck" });
      const diffUri = (await api.dispatchWebviewMessageForTests({
        type: "adoptCitation",
        key: "real2020",
      })) as vscode.Uri | undefined;
      assert.ok(diffUri, "a proposal diff should have opened");
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        diffUri,
      );
      assert.strictEqual(accepted, true, "accept should apply and save");
      const after = Buffer.from(
        await vscode.workspace.fs.readFile(bibUri),
      ).toString();
      assert.ok(after.includes("2021"), "the corrected year is on disk");
      // U2 manual-review item 2: the tab must not keep showing the stale
      // mismatch — the host re-checks the adopted key and updates its status.
      const status = await pollFor(() => {
        const r = api
          .lastCitationsC2ForTests()
          ?.results.find((x) => x.key === "real2020");
        return r?.status === "ok" ? r.status : undefined;
      });
      assert.strictEqual(status, "ok", "real2020 refreshes to Verified");
    } finally {
      api.clearCitationSourcesForTests();
    }
  });

  /**
   * D4 / CITE-1: re-running the check must verify what is on DISK.
   *
   * The repro from the backlog, confirmed in the code before the fix: run the
   * check, Accept a correction, hand-edit the `.bib` back to the wrong value,
   * re-run — and the entry was reported clean. `runCitationCheck` used the
   * module-level `lastCitationEntries` cache, which `refreshAdoptedCitation`
   * had just overwritten with the CORRECTED fields, and nothing invalidates it
   * on a file edit (there is no `.bib` watcher). So C2 re-verified text that no
   * longer existed.
   *
   * The hand edit is written with the file CLOSED. `VscodeWorkspace.readFile`
   * resolves staged copy → open buffer → disk (ADR 0002), so an unsaved editor
   * would be what C1 sees — more correct, but it would make this test assert
   * the buffer rather than the disk.
   */
  test("re-running the check sees a hand-edited bib, not the cached snapshot", async () => {
    const api = await getApi();
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const bibUri = vscode.Uri.file(
        path.join(path.dirname(uri.fsPath), "refs.bib"),
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
      await api.dispatchWebviewMessageForTests({ type: "runCitationCheck" });

      const diffUri = (await api.dispatchWebviewMessageForTests({
        type: "adoptCitation",
        key: "real2020",
      })) as vscode.Uri | undefined;
      assert.ok(diffUri, "a proposal diff should have opened");
      assert.strictEqual(
        await vscode.commands.executeCommand(
          "lemmaria.acceptProposal",
          diffUri,
        ),
        true,
        "accept should apply and save",
      );
      const corrected = await pollFor(() => {
        const r = api
          .lastCitationsC2ForTests()
          ?.results.find((x) => x.key === "real2020");
        return r?.status === "ok" ? r.status : undefined;
      });
      assert.strictEqual(corrected, "ok", "the accept refreshed the key");

      // The user reverts the entry by hand, in the editor, and saves — which
      // is what the repro describes and what ADR 0002's read order resolves:
      // staged copy → open BUFFER → disk. The Accept left the `.bib` open, so
      // writing straight to disk behind that buffer would test something no
      // user does.
      const bibDoc = await vscode.workspace.openTextDocument(bibUri);
      assert.ok(bibDoc.getText().includes("2021"), "precondition: fix applied");
      const revert = new vscode.WorkspaceEdit();
      const at = bibDoc.getText().indexOf("2021");
      revert.replace(
        bibUri,
        new vscode.Range(bibDoc.positionAt(at), bibDoc.positionAt(at + 4)),
        "2019",
      );
      assert.strictEqual(await vscode.workspace.applyEdit(revert), true);
      assert.strictEqual(await bibDoc.save(), true);

      await api.dispatchWebviewMessageForTests({ type: "runCitationCheck" });
      const again = await pollFor(() => {
        const r = api
          .lastCitationsC2ForTests()
          ?.results.find((x) => x.key === "real2020");
        return r?.status === "metadata_mismatch" ? r.status : undefined;
      });
      assert.strictEqual(
        again,
        "metadata_mismatch",
        "the re-check reported the regression rather than the cached fix",
      );
    } finally {
      api.clearCitationSourcesForTests();
    }
  });

  test("adoptCitation on a key with no correction does nothing", async () => {
    const api = await getApi();
    // orphan1999 ("Never Cited") gets no source match → not_found, no correction.
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await api.dispatchWebviewMessageForTests({ type: "requestCitations" });
      await api.dispatchWebviewMessageForTests({ type: "runCitationCheck" });
      const diffUri = await api.dispatchWebviewMessageForTests({
        type: "adoptCitation",
        key: "orphan1999",
      });
      assert.strictEqual(
        diffUri,
        undefined,
        "no diff for a correction-less key",
      );
    } finally {
      api.clearCitationSourcesForTests();
    }
  });
});
