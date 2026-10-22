/**
 * B7 — the Writing Skills view (ADR 0028).
 *
 * What only this suite can prove: that the bundled set actually ships (the
 * esbuild copy into `dist/skills` + the `extensionUri` resolution), and that
 * the LIVE tree provider hands out rows and renders them. `computeX` passing is
 * not evidence that `getChildren`/`getTreeItem` do — the U5 round-1 lesson.
 *
 * What it deliberately does NOT cover: the `project` source layer, which needs
 * a workspace folder the `@vscode/test-cli` host does not open. That layer is
 * pinned in the harness suites (`test/skills/loader.test.ts`,
 * `test/skills/library.test.ts`) and driven by the operator's checklist.
 */
import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface SkillsApi {
  refreshSkillsForTests(): Promise<void>;
  skillsTreeForTests(): {
    children: unknown[];
    items: vscode.TreeItem[];
    message: string | undefined;
    badge: number | undefined;
  };
  userSkillsDirForTests(): string;
  disabledSkillsForTests(): unknown[];
  currentSkillsForTests(): { name: string; source: string }[];
}

async function getApi(): Promise<SkillsApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as SkillsApi;
}

/** A row's hover text, whichever of the two shapes `TreeItem.tooltip` allows. */
function tooltipOf(item: vscode.TreeItem | undefined): string {
  const t = item?.tooltip;
  if (typeof t === "string") return t;
  return (t as vscode.MarkdownString | undefined)?.value ?? "";
}

suite("B7: the Writing Skills view", function () {
  this.timeout(30000);

  test("the bundled set ships and loads through extensionUri", async () => {
    // Proves the esbuild copy into dist/skills, which no harness test can:
    // bundledSkillsDir() reads the SOURCE tree, the extension reads its copy.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const labels = api
      .skillsTreeForTests()
      .items.map((i) => String(i.label))
      .sort();
    assert.deepStrictEqual(labels, [
      // R3 (ADR 0061): `blind-reviewer` is the fourth bundled skill — the
      // panel's protocol, which `/review` force-loads into every seat.
      "blind-reviewer",
      // V1 (ADR 0076): the panel verifier's protocol, force-loaded the same
      // way into every verifier child.
      "concern-verifier",
      "experiments-from-results",
      "methods-from-code",
      // V4 (ADR 0081): the PDF reviewer's addendum, force-loaded beside
      // blind-reviewer into the one seat that sees the compiled pages.
      "pdf-reviewer",
      "related-work",
    ]);
  });

  test("the live provider hands out a row per skill and renders each one", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    const tree = api.skillsTreeForTests();
    assert.strictEqual(
      tree.items.length,
      tree.children.length,
      "every child must render",
    );
    assert.ok(tree.items.length > 0, "the bundled set must produce rows");
    for (const item of tree.items) {
      assert.ok(item.label, "a row with no label would render blank");
      assert.ok(
        String(item.description).length > 0,
        "a row must carry its source",
      );
    }
  });

  test("the banner is a derived stats line and nothing else", async () => {
    // The U6 Glossary rule still holds — the counts are computed from what
    // actually loaded — but the prose around them is gone (gate-review round,
    // 2026-08-24): the operator asked for the stats alone. The two sentences
    // this drops are the load-on-demand claim and the "add your own at …"
    // hint; the first is documentation, and the second now has the Open Skill
    // File affordance beside it.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const tree = api.skillsTreeForTests();
    const message = tree.message ?? "";
    assert.ok(message, "a non-empty set must carry a banner");
    assert.ok(
      message.startsWith(`${tree.items.length} skills:`),
      `the banner must open with the total, got: ${message}`,
    );
    for (const label of ["this project", "global", "venue", "built in"]) {
      assert.ok(
        message.includes(label),
        `the banner must name every source, missing ${label}: ${message}`,
      );
    }
    assert.ok(
      !message.includes("load_skill") && !message.includes(".lemmaria/"),
      `the banner must carry no prose beyond the stats, got: ${message}`,
    );
  });

  test("the badge matches the number of loaded skills", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    const tree = api.skillsTreeForTests();
    assert.strictEqual(tree.badge, tree.items.length);
  });

  test("each row invokes Use a Writing Skill with its own name", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    for (const item of api.skillsTreeForTests().items) {
      assert.strictEqual(item.command?.command, "lemmaria.useSkill");
      assert.deepStrictEqual(item.command?.arguments, [String(item.label)]);
    }
  });

  test("the Use a Writing Skill command is registered", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("lemmaria.useSkill"),
      "lemmaria.useSkill must be registered",
    );
  });
});

/**
 * E1 — the user source and the per-skill toggle (ADR 0045).
 *
 * The `user` layer is `~/.lemmaria/skills`, redirected here by `LEMMARIA_HOME`
 * (set in `.vscode-test.mjs` so it is in the environment before the extension
 * activates). Only this suite can prove the layer at all: the harness suites
 * pass directories in, and it is the EXTENSION that decides where the user's
 * home is — the one thing invariant 1 forbids the harness from knowing.
 */
suite("E1: the user skills source and the toggle", function () {
  this.timeout(30000);

  let userDir: string;

  suiteSetup(async () => {
    const api = await getApi();
    userDir = api.userSkillsDirForTests();
    await mkdir(join(userDir, "my-voice"), { recursive: true });
    await writeFile(
      join(userDir, "my-voice", "SKILL.md"),
      "---\nname: my-voice\ndescription: How I like my own prose to read.\n---\n\nWrite plainly.\n",
      "utf8",
    );
  });

  suiteTeardown(async () => {
    await rm(join(userDir, "my-voice"), { recursive: true, force: true });
    // Leave no disabled selection behind — and check first rather than
    // toggling blind, because the last test already re-enabled it and an
    // unconditional toggle would DISABLE it and leave the entry behind
    // (found by review).
    const api = await getApi();
    if (api.disabledSkillsForTests().length > 0) {
      await vscode.commands.executeCommand(
        "lemmaria.skills.toggle",
        "my-voice",
      );
    }
    assert.strictEqual(api.disabledSkillsForTests().length, 0);
  });

  test("a SKILL.md under the user directory loads with the `global` label", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();

    const loaded = api.currentSkillsForTests();
    const mine = loaded.find((s) => s.name === "my-voice");
    assert.ok(mine, `the user skill must load, got: ${JSON.stringify(loaded)}`);
    assert.strictEqual(mine?.source, "user");

    const row = api
      .skillsTreeForTests()
      .items.find((i) => String(i.label) === "my-voice");
    assert.ok(row, "the user skill must have a row");
    assert.ok(
      String(row?.description).includes("global"),
      `the row must name its source, got: ${row?.description}`,
    );
  });

  test("the banner counts the user source", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    const message = api.skillsTreeForTests().message ?? "";
    assert.ok(
      message.includes("1 global"),
      `the banner must count the user source, got: ${message}`,
    );
  });

  test("the toggle disables a skill, and the selection survives a reload", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    assert.ok(
      api.currentSkillsForTests().some((s) => s.name === "my-voice"),
      "precondition: the skill is loaded before the toggle",
    );

    await vscode.commands.executeCommand("lemmaria.skills.toggle", "my-voice");
    assert.ok(
      !api.currentSkillsForTests().some((s) => s.name === "my-voice"),
      "the toggle must take the skill out of what a task is handed",
    );
    assert.strictEqual(api.disabledSkillsForTests().length, 1);

    // A reload of the view must not resurrect it: the selection is persisted,
    // not merely held in the loaded set.
    await api.refreshSkillsForTests();
    assert.ok(
      !api.currentSkillsForTests().some((s) => s.name === "my-voice"),
      "the disabled selection must survive a reload",
    );

    // A disabled skill is NOT a diagnostic — the user asked for this, so it is
    // not a problem to report. It keeps a row of its own (see the review-round
    // suite below), and the banner counts it.
    const tree = api.skillsTreeForTests();
    assert.ok(
      !tree.children.some(
        (c) => (c as { kind?: string }).kind === "unavailable",
      ),
      "a disabled skill must not appear as a failure row",
    );
    assert.ok(
      (tree.message ?? "").includes("1 disabled"),
      `the banner must account for the disabled skill, got: ${tree.message}`,
    );

    // And toggling again brings it back — the switch is a switch.
    await vscode.commands.executeCommand("lemmaria.skills.toggle", "my-voice");
    assert.ok(
      api.currentSkillsForTests().some((s) => s.name === "my-voice"),
      "toggling again must re-enable the skill",
    );
    assert.strictEqual(api.disabledSkillsForTests().length, 0);
  });

  test("a body routing to scripts/ still loads, with the note in its tooltip", async () => {
    // The honesty note (ADR 0046). It used to be a sibling ROW beneath the
    // skill; the gate-review round (2026-08-24) folded it into the tooltip,
    // because at pack density the notes outnumbered the skills and one skill
    // appeared as three rows. What ADR 0045 §3 requires is that a truncation or
    // a refusal is VISIBLE — not that it occupies a row — so the assertion
    // moves to the tooltip and the "no second row" half becomes explicit.
    const dir = join(userDir, "router");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: router\ndescription: Routes to a script.\n---\n\nRun scripts/fetch.py first.\n",
      "utf8",
    );
    try {
      const api = await getApi();
      await api.refreshSkillsForTests();

      assert.ok(
        api.currentSkillsForTests().some((s) => s.name === "router"),
        "the skill must STILL LOAD despite routing outside references/",
      );
      const items = api.skillsTreeForTests().items;
      const rows = items.filter((i) => String(i.label) === "router");
      assert.strictEqual(
        rows.length,
        1,
        "one skill is one row, however many notes it carries",
      );
      assert.ok(
        tooltipOf(rows[0]).includes("scripts"),
        `the note must reach the skill's tooltip, got: ${tooltipOf(rows[0])}`,
      );
      assert.strictEqual(
        (rows[0]?.iconPath as vscode.ThemeIcon | undefined)?.id,
        "book",
        "a skill that loaded must keep the book icon",
      );
      assert.ok(
        !items.some((i) => String(i.label).includes("scripts/")),
        "a note must not appear as a row of its own",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a symlinked references/ still loads, with the note in its tooltip", async () => {
    // The twin of the test above, and the one E1 shipped without. The second
    // review round added `references_not_followed` three rungs after the tier
    // table was written; the view kept its own list of Info codes and never
    // learned the third — so the note was hoisted to the top of the tree with
    // the `warning` icon and counted in the banner's "N could not be loaded",
    // printed directly above the row for the skill that DID load, whose own
    // message says "The skill still loads". Found cold at the gate record.
    //
    // `skills/tone/references -> ../_shared/refs` is the shape a pack sharing
    // reference text carries, and `git clone` reproduces it faithfully. The
    // refusal is correct (containment); reporting it as a load failure is not.
    const outside = await mkdtemp(join(tmpdir(), "lemmaria-shared-refs-"));
    await writeFile(join(outside, "shared.md"), "# shared\n", "utf8");
    const dir = join(userDir, "shared-refs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: shared-refs\ndescription: Shares its reference text with a sibling skill.\n---\n\nRead the taxonomy first.\n",
      "utf8",
    );
    try {
      try {
        await symlink(outside, join(dir, "references"), "junction");
      } catch {
        // Unprivileged Windows without Developer Mode cannot create links at
        // all. Skipping is honest; asserting nothing would not be — the same
        // guard `library.test.ts` uses for this fixture shape.
        return;
      }
      const api = await getApi();
      await api.refreshSkillsForTests();

      assert.ok(
        api.currentSkillsForTests().some((s) => s.name === "shared-refs"),
        "the skill must STILL LOAD despite the refused references/ link",
      );
      const items = api.skillsTreeForTests().items;
      const rows = items.filter((i) => String(i.label) === "shared-refs");
      assert.strictEqual(
        rows.length,
        1,
        "one skill is one row, however many notes it carries",
      );
      assert.ok(
        tooltipOf(rows[0]).includes("references"),
        `the tooltip must name what was not read, got: ${tooltipOf(rows[0])}`,
      );
      assert.strictEqual(
        (rows[0]?.iconPath as vscode.ThemeIcon | undefined)?.id,
        "book",
        "a skill that loaded must keep the book icon",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("each COPY of a twice-resolving name is disabled separately, from its row", async () => {
    // The case path selectors exist for, and the case the first fix got wrong:
    // keying identity purely by name made the second disable REMOVE the first
    // entry instead of adding a second, so the toggle acted as its own inverse
    // on a different skill (second review round). `related-work` ships bundled,
    // so shadowing it from the user directory gives two copies of one name.
    //
    // Driven from the ROW, which is the production route that carries a path —
    // a bare NAME cannot say which copy, and deliberately addresses the whole
    // name instead (see the next test).
    const dir = join(userDir, "related-work");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: related-work\ndescription: My own take on related work.\n---\n\nMine.\n",
      "utf8",
    );
    try {
      const api = await getApi();
      await api.refreshSkillsForTests();

      const rowFor = (name: string): unknown =>
        api
          .skillsTreeForTests()
          .children.find(
            (c) =>
              (c as { kind?: string; skill?: { name?: string } }).kind ===
                "skill" &&
              (c as { skill: { name: string } }).skill.name === name,
          );
      const sourceOf = (name: string): string | undefined =>
        api.currentSkillsForTests().find((sk) => sk.name === name)?.source;

      // The user copy wins the merge, so that is the row on offer.
      assert.strictEqual(sourceOf("related-work"), "user");

      // Disable it from its row → the BUNDLED copy takes its place.
      await vscode.commands.executeCommand(
        "lemmaria.skills.toggle",
        rowFor("related-work"),
      );
      assert.strictEqual(api.disabledSkillsForTests().length, 1);
      assert.strictEqual(
        sourceOf("related-work"),
        "bundled",
        "disabling the user copy must fall back, not remove the name",
      );

      // Disable THAT row too. The first fix removed the existing entry here
      // and the user copy came back; both must now be off.
      await vscode.commands.executeCommand(
        "lemmaria.skills.toggle",
        rowFor("related-work"),
      );
      assert.strictEqual(
        api.disabledSkillsForTests().length,
        2,
        "each copy must hold its own entry",
      );
      assert.strictEqual(
        sourceOf("related-work"),
        undefined,
        "with both copies disabled the name must be gone",
      );

      // A bare name then brings the whole thing back in one call.
      await vscode.commands.executeCommand(
        "lemmaria.skills.toggle",
        "related-work",
      );
      assert.strictEqual(api.disabledSkillsForTests().length, 0);
      assert.strictEqual(sourceOf("related-work"), "user");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bare NAME addresses the whole name, because it cannot say which copy", async () => {
    // Deliberate, and the alternative ping-pongs: addressing "the loaded copy"
    // means re-enabling one copy makes it the merge winner, so the next call
    // disables it again and a two-copy name can never come fully back on.
    const api = await getApi();
    await api.refreshSkillsForTests();
    await vscode.commands.executeCommand(
      "lemmaria.skills.toggle",
      "related-work",
    );
    assert.strictEqual(api.disabledSkillsForTests().length, 1);
    await vscode.commands.executeCommand(
      "lemmaria.skills.toggle",
      "related-work",
    );
    assert.strictEqual(
      api.disabledSkillsForTests().length,
      0,
      "a second by-name toggle must re-enable, not disable a second copy",
    );
  });

  test("the toggle command is registered", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("lemmaria.skills.toggle"),
      "lemmaria.skills.toggle must be registered",
    );
  });
});

/**
 * E1, gate-review round (2026-08-24) — the Skills view at pack density.
 *
 * Driving `tests/e1/1-pack-at-density` answered Judge question 1 the way the
 * scenario feared it might: 21 skills produced ~50 flat rows, one skill
 * appearing as three of them, and the row text ran the full width of the panel.
 * The operator's direction was *one row per skill, the name as the label, the
 * source as the grey text, everything else in the hover* — so the notes moved
 * into the tooltip, the banner shrank to its counts, and a second inline icon
 * opens the skill's own `SKILL.md` read-only.
 *
 * What only this suite can prove: that the LIVE provider renders that shape.
 * The harness still owns every diagnostic and the budget ladder — none of that
 * changed, and none of it is re-asserted here.
 */
suite("E1 review round: one row per skill", function () {
  this.timeout(30000);

  let userDir: string;

  suiteSetup(async () => {
    const api = await getApi();
    userDir = api.userSkillsDirForTests();
    await mkdir(join(userDir, "one-row"), { recursive: true });
    await writeFile(
      join(userDir, "one-row", "SKILL.md"),
      "---\nname: one-row\ndescription: A description long enough that showing it on the row would fill the whole panel width.\n---\n\nWrite plainly.\n",
      "utf8",
    );
  });

  suiteTeardown(async () => {
    await rm(join(userDir, "one-row"), { recursive: true, force: true });
  });

  test("a row's grey text is the source and nothing else", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    const row = api
      .skillsTreeForTests()
      .items.find((i) => String(i.label) === "one-row");
    assert.ok(row, "the skill must have a row");
    assert.strictEqual(
      String(row?.description),
      "global",
      "the grey text is the source label alone — the description belongs in the hover",
    );
  });

  test("the hover carries the description and the location", async () => {
    // The row lost the description, so the tooltip is now the ONLY place it is
    // legible. Losing both would be a silent regression, not a cleanup.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const row = api
      .skillsTreeForTests()
      .items.find((i) => String(i.label) === "one-row");
    const hover = tooltipOf(row);
    assert.ok(
      hover.includes("would fill the whole panel width"),
      `the hover must carry the full description, got: ${hover}`,
    );
    assert.ok(
      hover.includes(join(userDir, "one-row")),
      `the hover must carry the skill's location, got: ${hover}`,
    );
  });

  test("every row in the view is a skill, never a diagnostic", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    for (const child of api.skillsTreeForTests().children) {
      const kind = (child as { kind?: string }).kind;
      assert.ok(
        kind === "skill" || kind === "unavailable",
        `a row must be a skill, got kind=${kind}`,
      );
    }
  });

  test("a skill that could not be loaded is one marked row, not a banner", async () => {
    // ADR 0045 §3: the drop must stay VISIBLE. It no longer takes a sentence in
    // the banner and a warning row at the top of the list — it is the skill's
    // own row, wearing a warning icon, with the reason in its hover.
    const dir = join(userDir, "broken-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: broken-skill\n---\n\nNo description, so it cannot load.\n",
      "utf8",
    );
    try {
      const api = await getApi();
      await api.refreshSkillsForTests();
      assert.ok(
        !api.currentSkillsForTests().some((s) => s.name === "broken-skill"),
        "precondition: the malformed skill does not load",
      );
      const rows = api
        .skillsTreeForTests()
        .items.filter((i) => String(i.label) === "broken-skill");
      assert.strictEqual(rows.length, 1, "a failed skill is still one row");
      assert.strictEqual(
        (rows[0]?.iconPath as vscode.ThemeIcon | undefined)?.id,
        "warning",
        "a skill that did not load must say so on its row",
      );
      assert.ok(
        tooltipOf(rows[0]).length > 0,
        "the reason must be in the hover",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Open Skill File shows the file read-only, titled by the skill", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    await vscode.commands.executeCommand("lemmaria.skills.open", "one-row");
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "the command must open an editor");
    try {
      assert.strictEqual(
        editor?.document.uri.scheme,
        "lemmaria-skill",
        "the preview must not open the real file, which would be writable",
      );
      assert.ok(
        editor?.document.uri.path.endsWith("/one-row.md"),
        `the tab must be titled by the skill, got: ${editor?.document.uri.path}`,
      );
      assert.ok(
        editor?.document.getText().includes("Write plainly."),
        "the preview must show the file's real body, not just its front matter",
      );
      // What "read-only" actually rests on, and it is structural rather than a
      // UI flag: the scheme has no `FileSystemProvider` behind it, so there is
      // no route from this buffer back to the user's file. Asserting that
      // `workspace.applyEdit` is refused would be asserting the wrong thing —
      // it edits the in-memory model and VS Code allows it; what it can never
      // do is reach disk.
      assert.notStrictEqual(
        vscode.workspace.fs.isWritableFileSystem("lemmaria-skill"),
        true,
        "nothing may be writable through the preview scheme",
      );
    } finally {
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    }
  });

  test("the Open Skill File command is registered", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("lemmaria.skills.open"),
      "lemmaria.skills.open must be registered",
    );
  });
});

/**
 * E1, second gate-review round (2026-08-25) — a disabled skill keeps its row.
 *
 * It used to vanish from the view entirely, because the harness filtered it
 * before the merge and handed the extension nothing to render. The only way
 * back was a palette command, which is a switch you can turn off and then not
 * find again. `loadSkillSet` now returns what it filtered, and these rows are
 * what it is for.
 */
suite("E1 review round 2: the disabled skills stay visible", function () {
  this.timeout(30000);

  let userDir: string;

  const rowsOf = (api: SkillsApi) =>
    api.skillsTreeForTests().children as {
      kind: string;
      skill?: { name: string };
    }[];

  suiteSetup(async () => {
    const api = await getApi();
    userDir = api.userSkillsDirForTests();
    await mkdir(join(userDir, "switched-off"), { recursive: true });
    await writeFile(
      join(userDir, "switched-off", "SKILL.md"),
      "---\nname: switched-off\ndescription: A skill the user turned off and must be able to turn on again.\n---\n\nOff.\n",
      "utf8",
    );
    await getApi();
  });

  suiteTeardown(async () => {
    const api = await getApi();
    if (api.disabledSkillsForTests().length > 0) {
      await vscode.commands.executeCommand(
        "lemmaria.skills.toggle",
        "switched-off",
      );
    }
    await rm(join(userDir, "switched-off"), { recursive: true, force: true });
    assert.strictEqual(api.disabledSkillsForTests().length, 0);
  });

  test("a disabled skill keeps a row, marked, and is not handed to the model", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    await vscode.commands.executeCommand(
      "lemmaria.skills.toggle",
      "switched-off",
    );

    assert.ok(
      !api.currentSkillsForTests().some((s) => s.name === "switched-off"),
      "a disabled skill must still be kept out of what a task is handed",
    );

    const row = api
      .skillsTreeForTests()
      .items.find((i) => String(i.label) === "switched-off");
    assert.ok(row, "a disabled skill must keep a row — otherwise it is gone");
    assert.strictEqual(
      (row?.iconPath as vscode.ThemeIcon | undefined)?.id,
      "circle-slash",
      "the row must show it is switched off",
    );
    assert.ok(
      String(row?.description).length > 0,
      "the row must say it is disabled",
    );
    assert.ok(
      tooltipOf(row).includes("must be able to turn on again"),
      "the hover must still say what the skill was",
    );
  });

  test("the disabled rows come last, after every loaded skill", async () => {
    const api = await getApi();
    await api.refreshSkillsForTests();
    const kinds = rowsOf(api).map((r) => r.kind);
    const firstDisabled = kinds.indexOf("disabled");
    assert.ok(firstDisabled >= 0, "precondition: a disabled row is present");
    assert.ok(
      !kinds.slice(firstDisabled).includes("skill"),
      `a loaded skill must not follow a disabled one, got: ${kinds.join(",")}`,
    );
  });

  test("the row's own toggle turns it back on", async () => {
    // The whole point of the row. Driven from the ROW, which is the production
    // route — the palette already worked, and it is what this replaces.
    const api = await getApi();
    await api.refreshSkillsForTests();
    const row = rowsOf(api).find(
      (r) => r.kind === "disabled" && r.skill?.name === "switched-off",
    );
    assert.ok(row, "precondition: the disabled row is there to click");

    await vscode.commands.executeCommand("lemmaria.skills.toggle", row);
    assert.ok(
      api.currentSkillsForTests().some((s) => s.name === "switched-off"),
      "toggling the disabled row must re-enable the skill",
    );
    assert.strictEqual(api.disabledSkillsForTests().length, 0);
    assert.ok(
      !rowsOf(api).some((r) => r.kind === "disabled"),
      "and the disabled row must go once it is enabled",
    );
  });
});
