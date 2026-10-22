import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Lemmaria extension (M4 surface)", () => {
  test("activates and registers the M4 commands", async () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension lemmaria.lemmaria not found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "lemmaria.polish",
      "lemmaria.shrinkToTarget",
      "lemmaria.expand", // A5 — no longer a "coming in v0.2" shell
      "lemmaria.proofread",
      "lemmaria.translate",
      "lemmaria.setApiKey",
      "lemmaria.acceptProposal",
      "lemmaria.rejectProposal",
      "lemmaria.retryProposal",
    ]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });
});
