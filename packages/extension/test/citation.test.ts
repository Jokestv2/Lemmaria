// M7 acceptance surface: the Check Citations command runs C1 (offline
// consistency → diagnostics) and C2 (online metadata, against an INJECTED mock
// source — the ext-host runner has no network), surfacing the request endpoint
// and offering an Accept-gated BibDiff correction. Drives the real bundled
// extension; C1 needs no TeX toolchain.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CitationMetadata,
  CitationQuery,
  CitationResult,
  CitationSource,
  Warning,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface CitationOutcome {
  status: string;
  message?: string;
  consistency: Warning[];
  metadata: CitationResult[];
  endpoints: string[];
}
interface LemmariaApi {
  setCitationSourcesForTests(sources: CitationSource[]): void;
  clearCitationSourcesForTests(): void;
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
`;

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

async function makeProject(): Promise<vscode.Uri> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-m7-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const main = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(main, Buffer.from(MAIN, "utf8"));
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(path.join(dir, "refs.bib")),
    Buffer.from(REFS, "utf8"),
  );
  return main;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await delay(50);
  }
  return pred();
}

suite("M7: Citation checking in the editor", function () {
  this.timeout(20000);

  test("Check Citations reports C1 diagnostics + C2 metadata (endpoint shown)", async () => {
    const api = await getApi();
    // real2020: bib year 2019, source says 2021 → metadata_mismatch.
    api.setCitationSourcesForTests([
      mockSource("crossref", (q) =>
        q.title?.includes("Real") || q.doi ? { year: "2021" } : null,
      ),
    ]);
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.checkCitations",
      )) as CitationOutcome;
      assert.strictEqual(outcome.status, "checked", outcome.message);
      // C1: the hallucinated key is flagged.
      assert.ok(
        outcome.consistency.some((w) => w.code === "undefined-citation"),
        "expected an undefined-citation for ghost2099",
      );
      // C1 diagnostics were published to the editor.
      const ok = await waitFor(
        () => vscode.languages.getDiagnostics(uri).length > 0,
      );
      assert.ok(ok, "expected a citation diagnostic on main.tex");
      // C2: the real key gets a status, and the endpoint is surfaced.
      const real = outcome.metadata.find((r) => r.key === "real2020");
      assert.strictEqual(real?.status, "metadata_mismatch");
      assert.ok(
        outcome.endpoints.some((e) => e.includes("crossref")),
        "expected the crossref endpoint to be surfaced",
      );
    } finally {
      api.clearCitationSourcesForTests();
    }
  });
});
