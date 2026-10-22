// M10 acceptance: "Lemmaria: New from Venue" scaffolds a project from the
// bundled venue set (copied into dist/venues at build time) into an empty
// folder, runs the baseline compile through the injected test compile, and
// refuses a non-empty target. Drives the REAL bundled extension through the
// command with positional args (bypassing QuickPick/dialog, the M4 precedent).
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompileProjectOptions, ScaffoldReport } from "@lemmaria/harness";
import * as vscode from "vscode";

interface VenueOutcome {
  status: string;
  message?: string;
  report?: ScaffoldReport;
}

interface LemmariaApi {
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>,
  ): void;
  clearCompileForTests(): void;
  getScaffoldReportForTests(): ScaffoldReport | undefined;
}

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

function tmpTarget(): string {
  return path.join(
    os.tmpdir(),
    `lemmaria-m10-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

suite("M10: New from Venue", function () {
  this.timeout(20000);

  test("scaffolds ieee-conference into an empty folder with the injected compile", async () => {
    const api = await getApi();
    const calls: CompileProjectOptions[] = [];
    api.setCompileForTests((opts) => {
      calls.push(opts);
      return Promise.resolve({ ok: true, log: "clean" });
    });
    const target = tmpTarget();
    try {
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.newFromVenue",
        "ieee-conference",
        vscode.Uri.file(target),
      )) as VenueOutcome;
      assert.strictEqual(outcome.status, "scaffolded", outcome.message);
      assert.deepStrictEqual(fs.readdirSync(target).sort(), [
        "PAPER.md",
        "main.tex",
        "references.bib",
        "requirements.md",
      ]);
      assert.strictEqual(calls.length, 1, "compile stub not called once");
      assert.strictEqual(calls[0]?.engine, "pdflatex");
      assert.strictEqual(
        path.normalize(calls[0]?.root ?? "").toLowerCase(),
        path.normalize(target).toLowerCase(),
      );
      const report = api.getScaffoldReportForTests();
      assert.ok(report, "no report stored");
      assert.strictEqual(report.venueId, "ieee-conference");
      assert.deepStrictEqual(report.compile, {
        engine: "pdflatex",
        ok: true,
        log: "clean",
      });
    } finally {
      api.clearCompileForTests();
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test("a second run into the same folder refuses and leaves it untouched", async () => {
    const api = await getApi();
    api.setCompileForTests(() => Promise.resolve({ ok: true, log: "" }));
    const target = tmpTarget();
    try {
      const first = (await vscode.commands.executeCommand(
        "lemmaria.newFromVenue",
        "ieee-conference",
        vscode.Uri.file(target),
      )) as VenueOutcome;
      assert.strictEqual(first.status, "scaffolded", first.message);
      const before = fs.readdirSync(target).sort();

      const second = (await vscode.commands.executeCommand(
        "lemmaria.newFromVenue",
        "ieee-conference",
        vscode.Uri.file(target),
      )) as VenueOutcome;
      assert.strictEqual(second.status, "error");
      assert.match(second.message ?? "", /not empty|非空/);
      assert.deepStrictEqual(fs.readdirSync(target).sort(), before);
      // The stored report is still the first (successful) run's.
      assert.strictEqual(
        api.getScaffoldReportForTests()?.venueId,
        "ieee-conference",
      );
    } finally {
      api.clearCompileForTests();
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test("the command is registered", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("lemmaria.newFromVenue"));
  });
});
