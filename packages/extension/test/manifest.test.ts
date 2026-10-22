/**
 * P1 (rows O1, O2): the manifest is publishable, and every icon it names is on
 * disk.
 *
 * Both halves fail *silently* everywhere else. `"private": true` is accepted by
 * VS Code and by every test in this suite — `vsce` is the only thing that ever
 * reads it, and it reads it at the moment the operator tries to package. An
 * icon path that points at nothing renders as a blank square in the Activity
 * Bar, which is indistinguishable from a mark that is simply too faint.
 *
 * So these assertions exist to make a packaging failure a *test* failure, at
 * the gate, rather than a surprise at the publish step.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface Manifest {
  private?: boolean;
  icon?: string;
  version?: string;
  description?: string;
  publisher?: string;
  license?: string;
  repository?: unknown;
  bugs?: unknown;
  homepage?: unknown;
  categories?: string[];
  keywords?: string[];
  contributes?: {
    commands?: { icon?: string | { light?: string; dark?: string } }[];
    viewsContainers?: Record<string, { icon?: string }[]>;
  };
}

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return ext.extensionPath;
}

suite("Extension manifest — publishable", () => {
  const root = extensionRoot();
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as Manifest;

  test("is not private", () => {
    // `vsce package` refuses a private manifest outright, with no way to
    // override it. The M0 scaffold set it; nothing since has needed it.
    assert.notStrictEqual(
      pkg.private,
      true,
      'package.json must not set "private": true — vsce refuses it',
    );
  });

  test("names a listing icon that exists and is a PNG of at least 128px", () => {
    assert.ok(pkg.icon, "package.json must name an icon");
    const icon = path.join(root, pkg.icon);
    assert.ok(fs.existsSync(icon), `icon not found: ${pkg.icon}`);
    assert.ok(pkg.icon.endsWith(".png"), "the Marketplace icon must be a PNG");
    // The PNG header carries the dimensions at bytes 16..24 (IHDR). The
    // Marketplace requires 128x128 or larger; the pack ships 256.
    const header = fs.readFileSync(icon).subarray(0, 24);
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    assert.ok(
      width >= 128 && height >= 128,
      `icon must be at least 128x128, got ${width}x${height}`,
    );
    assert.strictEqual(width, height, "the listing icon must be square");
  });

  test("carries the metadata a listing page is composed from", () => {
    assert.ok(pkg.publisher, "publisher is required to publish");
    assert.ok(pkg.license, "license is required");
    // `repository`, `homepage` and `bugs` are deliberately ABSENT and asserted
    // so. While github.com/Jokestv2/Lemmaria was private they had to be: it
    // answered 404 unauthenticated, so the Marketplace would have rendered
    // three dead links. The repo has been public since 2026-10-19, and keeping
    // them absent is now an operator decision (2026-10-20), not a necessity —
    // adding them changes the listing, so it is made deliberately, with a
    // publish. Bug reports go to the repo's Issues through a link in the
    // extension README; `qna` stays at its default.
    assert.ok(
      !pkg.repository,
      "repository stays absent by operator decision (see comment)",
    );
    assert.ok(
      !pkg.bugs,
      "bugs stays absent by operator decision (see comment)",
    );
    assert.ok(
      !pkg.homepage,
      "homepage stays absent by operator decision (see comment)",
    );
    assert.ok(
      pkg.categories && pkg.categories.length > 0,
      "categories drive Marketplace discovery",
    );
    assert.ok(
      !pkg.categories?.includes("Other") || pkg.categories.length > 1,
      '"Other" alone is the scaffold default, not a category',
    );
    assert.ok(
      pkg.keywords && pkg.keywords.length > 0,
      "keywords are what a search actually matches",
    );
  });

  test("the description describes the product, not the scaffold", () => {
    assert.ok(pkg.description, "description is required");
    const description = String(pkg.description);
    // The M0 text said "(M0 scaffold)" and survived every milestone since.
    // Neither a milestone id nor a stage label belongs on a listing page.
    assert.ok(
      !/\b(scaffold|TODO|WIP|placeholder)\b/i.test(description),
      `description still reads as build-internal: ${description}`,
    );
    assert.ok(
      !/\bv?\d+\.\d+\b/.test(description),
      "a version in the description is a promise the manifest already makes",
    );
  });

  test("the version is not the scaffold's 0.0.1", () => {
    assert.ok(pkg.version, "version is required");
    assert.notStrictEqual(pkg.version, "0.0.1");
    assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/);
  });

  test("every icon path the manifest names resolves on disk", () => {
    const paths: string[] = [];
    for (const container of Object.values(
      pkg.contributes?.viewsContainers ?? {},
    ))
      for (const entry of container) if (entry.icon) paths.push(entry.icon);
    for (const command of pkg.contributes?.commands ?? []) {
      const icon = command.icon;
      // A `$(codicon)` reference is a theme icon, not a file — skip those.
      if (typeof icon === "string") {
        if (!icon.startsWith("$(")) paths.push(icon);
      } else if (icon) {
        if (icon.light) paths.push(icon.light);
        if (icon.dark) paths.push(icon.dark);
      }
    }
    assert.ok(paths.length > 0, "expected at least the container icons");
    const missing = paths.filter((p) => !fs.existsSync(path.join(root, p)));
    assert.deepStrictEqual(missing, [], "icon paths that resolve to nothing");
  });

  test("ships no M0 placeholder mark", () => {
    // The three scaffold SVGs were one rotated <rect> each. They are deleted,
    // not left beside the real artwork — a stale path is how the placeholder
    // comes back.
    for (const stale of [
      "media/lemmaria.svg",
      "media/lemmaria-light.svg",
      "media/lemmaria-dark.svg",
    ])
      assert.ok(
        !fs.existsSync(path.join(root, stale)),
        `${stale} is the M0 placeholder and must be gone`,
      );
  });

  test("the files that must SHIP beside the code are present", () => {
    // Deliberately only files that end up inside the `.vsix`: the listing page,
    // the changelog the "Changelog" tab reads, and the licence the manifest's
    // "SEE LICENSE IN LICENSE.txt" points at. There is no `NOTICE`: the
    // extension's own licence asks for none, and the notices its third-party code
    // requires travel in THIRD-PARTY-NOTICES.md, which row O7 checks.
    // `.vscodeignore` is NOT here — vsce strips
    // it from the package it produces, so asserting it at the extension root
    // would be asserting a property of the checkout, and row O7's
    // `check-vsix-contents.mjs` reads the packaged file list instead.
    for (const file of ["README.md", "CHANGELOG.md", "LICENSE.txt"])
      assert.ok(
        fs.existsSync(path.join(root, file)),
        `${file} is missing — vsce warns, or the listing page is empty`,
      );
  });
});
