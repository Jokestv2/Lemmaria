/**
 * V3 (O8): **nobody registers `view_pdf_pages` in V3.**
 *
 * The harness side is pinned in `tools.test.ts` (`buildToolRegistry` has no
 * factory for it) and in `contracts.test.ts` (the allowlist grew by exactly
 * one name). This is the HOST side: the extension's own registry builder lists
 * its tools explicitly, and the name is not on that list.
 *
 * V3 builds the door and V4 walks the panel through it, so a registry that
 * quietly acquired the tool early — before any seat, any budget accounting or
 * any `ReviewLimit` existed for it — is exactly the regression worth a test of
 * its own.
 */
import * as assert from "node:assert/strict";
import type { ToolExecutor, ToolName } from "@lemmaria/harness";
import * as vscode from "vscode";

interface RegistryApi {
  sessionRegistryForTests(): Promise<Map<ToolName, ToolExecutor>>;
}

async function api(): Promise<RegistryApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as RegistryApi;
}

suite("the session registry does not hold view_pdf_pages (V3, O8)", () => {
  test("buildSessionRegistry produces no such executor", async () => {
    const registry = await (await api()).sessionRegistryForTests();
    assert.equal(
      registry.has("view_pdf_pages"),
      false,
      "no production path registers view_pdf_pages in V3",
    );
  });

  test("and the registry is otherwise non-empty, so the check means something", async () => {
    // A builder that returned an empty Map would pass the test above for the
    // wrong reason.
    const registry = await (await api()).sessionRegistryForTests();
    assert.ok(registry.size > 0, "the registry should still build its tools");
  });
});
