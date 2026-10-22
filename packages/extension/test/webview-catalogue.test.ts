/**
 * E2 (ADR 0049) — the host half of the composer command menu.
 *
 * What only this suite can prove: that the loaded catalogue actually reaches
 * the webview, and that `/compact` reaches the same function the palette
 * command reaches. Both are host wiring, so neither is visible to the jsdom
 * project, and both are cheap to break silently — the catalogue push is a new
 * message type nobody else posts, and `compactSession` is the one of the three
 * verbs that had no webview twin to reuse.
 */
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "../src/webview-protocol";

interface CatalogueApi {
  revealWebviewForTests(): Promise<void>;
  refreshSkillsForTests(): Promise<void>;
  currentSkillsForTests(): { name: string; source: string }[];
  postedToWebviewForTests(): readonly HostToWebview[];
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  compactSessionForTests(): Promise<boolean>;
}

async function getApi(): Promise<CatalogueApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as unknown as CatalogueApi;
}

/** The most recent catalogue push, if any. */
function lastCatalogue(
  posted: readonly HostToWebview[],
): { name: string; description: string }[] | undefined {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i];
    if (m?.type === "skillsCatalogue") return m.skills;
  }
  return undefined;
}

suite("E2: the skills catalogue reaches the composer", function () {
  this.timeout(60000);

  test("a refresh PUSHES the catalogue rather than waiting to be asked", async () => {
    // E1 shipped a runtime toggle, so the enabled set moves while the panel is
    // open. A menu that polled would offer a slug the harness has since
    // stopped accepting — the failure mode §8 chose push to avoid.
    const api = await getApi();
    await api.revealWebviewForTests();
    await api.refreshSkillsForTests();

    const pushed = lastCatalogue(api.postedToWebviewForTests());
    assert.ok(pushed, "no skillsCatalogue was ever posted");
    const loaded = api
      .currentSkillsForTests()
      .map((s) => s.name)
      .sort();
    assert.deepStrictEqual(
      pushed.map((s) => s.name).sort(),
      loaded,
      "the pushed catalogue is not the loaded one",
    );
    assert.ok(
      loaded.length > 0,
      "no skills loaded; the claim would be vacuous",
    );
  });

  test("it carries name and description ONLY — never the path", async () => {
    // `Skill.path` is UI provenance E1 deliberately keeps from the model, and
    // `body` is the guidance itself. The menu needs neither, so neither goes on
    // this wire: putting a path there would be a decision about provenance
    // rather than a field addition.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const pushed = lastCatalogue(api.postedToWebviewForTests());
    assert.ok(pushed);
    for (const row of pushed) {
      assert.deepStrictEqual(
        Object.keys(row).sort(),
        ["description", "name"],
        `unexpected fields on ${row.name}`,
      );
    }
  });

  test("every pushed name is one the invocation grammar accepts", async () => {
    // The stage's load-bearing rule, checked at the wire rather than only in
    // the ranker: the menu must not be able to produce a string the engine
    // ignores. The loader already rejects a bad slug with `invalid_name`, so
    // this fails only if something downstream of it starts rewriting names.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const pushed = lastCatalogue(api.postedToWebviewForTests());
    assert.ok(pushed);
    for (const row of pushed) {
      assert.match(row.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, row.name);
    }
  });
});

suite("E2: /compact reaches the palette command's own function", function () {
  this.timeout(60000);

  test("the message is ROUTED to compaction, and an unknown one is not", async () => {
    // **What this proves, stated narrowly on purpose.** An earlier version of
    // this test compared `dispatchWebviewMessageForTests({compactSession})`
    // against `compactSessionForTests()` and called the equality proof that
    // the two routes are "the SAME call". It was not: with no active session
    // both refuse at `lifecycle.ts`'s first branch and return `false`, so the
    // equality held for a reason unrelated to the claim. Caught at E2's code
    // review, and narrowed rather than deleted.
    //
    // That the menu's verb and the palette command run the same function is a
    // one-line SOURCE fact (`webview-view.ts`'s branch returns
    // `compactActiveSession(...)`, which is what `extension.ts` registers the
    // command as) and no ext-host assertion can see it. What an assertion CAN
    // see is the wire: the message reaches a handler that answers like
    // compaction, and a message that does not exist does not.
    const api = await getApi();
    const viaMenu = await api.dispatchWebviewMessageForTests({
      type: "compactSession",
    });
    assert.strictEqual(
      typeof viaMenu,
      "boolean",
      "the message was dropped rather than routed",
    );
    // The contrast is what makes the line above non-vacuous: an unrouted
    // message falls off the end of the branch chain and answers `undefined`.
    const unknown = await api.dispatchWebviewMessageForTests({
      type: "lemmariaNoSuchMessage",
    } as never);
    assert.strictEqual(unknown, undefined);
    // And with no session in this host, compaction refuses rather than throws
    // — the same answer the palette command gives from the same state.
    assert.strictEqual(viaMenu, await api.compactSessionForTests());
  });
});
