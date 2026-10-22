/**
 * The NLS bundle is the seam that lets contributed `package.json` strings render
 * English-only by default and `English / 中文` in a Chinese VS Code (see
 * product-design-EN.md §Bilingual First-class Citizens). These checks guard the
 * two ways it silently rots: a `%key%` with no bundle entry (renders the raw
 * `%key%` to the user) and the two bundles drifting out of key-parity.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return ext.extensionPath;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

suite("NLS bundle", () => {
  const root = extensionRoot();
  const pkgText = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const en = readJson(path.join(root, "package.nls.json"));
  const zh = readJson(path.join(root, "package.nls.zh-cn.json"));
  const used = [...pkgText.matchAll(/%([^%]+)%/g)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined);

  test("every %key% used in package.json resolves in both bundles", () => {
    const missingEn = used.filter((k) => !(k in en));
    const missingZh = used.filter((k) => !(k in zh));
    assert.deepStrictEqual(missingEn, [], "keys missing from package.nls.json");
    assert.deepStrictEqual(
      missingZh,
      [],
      "keys missing from package.nls.zh-cn.json",
    );
  });

  test("no contributed string advertises an unshipped version (A5)", () => {
    // A5's stale-shell sweep: "Coming in v0.2" survived into v0.2 itself, and
    // the U4 "Migrate to Venue (v0.4)" label outlived the roadmap revision that
    // moved venue migration to "Later". A version tag in a SHIPPED string is a
    // promise the code either already keeps (so the tag is wrong) or does not
    // (so the tag is a guess) — neither belongs in a contributed label.
    const tagged = [...Object.entries(en), ...Object.entries(zh)].filter(
      ([, value]) => /v0\.\d/.test(String(value)),
    );
    assert.deepStrictEqual(
      tagged,
      [],
      "contributed strings must not carry a version tag",
    );
  });

  test("the two bundles have identical key sets", () => {
    assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  });

  test("no bundle key is unused (dead translation)", () => {
    const usedSet = new Set(used);
    assert.deepStrictEqual(
      Object.keys(en).filter((k) => !usedSet.has(k)),
      [],
    );
  });

  test("no contributed string is left as a hardcoded bilingual literal", () => {
    // Every user-facing contributed string now flows through %key%; a stray
    // CJK character in package.json means a literal slipped the bundle.
    assert.doesNotMatch(
      pkgText,
      /[一-鿿]/,
      "package.json still contains CJK — a contributed string was not moved to the NLS bundle",
    );
  });

  // E6 (ADR 0058 §4): the palette command that used to *only* restore files now
  // offers all three arms through a QuickPick — fork alone, rewind alone, or
  // both. Its label is the only thing that tells a user which of those they are
  // about to get, and it read "Restore Files to Before the Last Message" until
  // this milestone re-worded it. Pinned here, in both bundles, because a label
  // that names one of three arms is a promise the command no longer keeps.
  test("the palette rewind command's label names the fork, not just the restore", () => {
    const key = "cmd.restoreSessionCheckpoint";
    const enLabel = String(en[key]);
    const zhLabel = String(zh[key]);
    assert.match(enLabel, /fork/i, `${key} (en) must name the fork arm`);
    assert.match(enLabel, /rewind/i, `${key} (en) must name the rewind arm`);
    assert.match(zhLabel, /分叉/, `${key} (zh) must name the fork arm`);
    assert.match(zhLabel, /回退/, `${key} (zh) must name the rewind arm`);
    // ADR 0058 retired "branch"/"分支" from the whole rewind vocabulary, and
    // `chrome-strings.test.ts` bans both there; the contributed label is the
    // one user-facing string that sweep cannot see.
    assert.doesNotMatch(enLabel, /branch/i);
    assert.doesNotMatch(zhLabel, /分支/);
  });

  test("English bundle names carry no Chinese; prose keys may", () => {
    // Command/view NAME keys must be English-only in the default bundle.
    for (const [k, v] of Object.entries(en)) {
      if (
        k.startsWith("cmd.") ||
        k.startsWith("view.") ||
        k.startsWith("container.")
      ) {
        assert.doesNotMatch(
          String(v),
          /[一-鿿]/,
          `default bundle name ${k} must be English-only`,
        );
      }
    }
  });

  // ADR 0024: a failed tool row names its reason in the reader's language. The
  // `Record<ToolErrorCode, string>` in `formatToolResult` already forces both
  // tables to carry every code at TYPECHECK time; this catches the other half —
  // a zh label left as its English placeholder, which typechecks fine and
  // renders English to a Chinese reader (invariant 6).
  test("every tool-error code has a genuinely Chinese label", () => {
    // D2 (ADR 0037) moved the locale table out of `main.ts` into
    // `parts/strings.ts` so both locales could be asserted offline. This
    // source-text check follows it; the parity half of what it used to do is
    // now also covered directly, in `test-webview/strings.test.ts`.
    const main = fs.readFileSync(
      path.join(root, "src", "webview", "parts", "strings.ts"),
      "utf8",
    );
    const codes = [
      "NotFound",
      "Denied",
      "TooLarge",
      "Refused",
      "RateLimited",
      "Unavailable",
      "Invalid",
    ];
    for (const code of codes) {
      const key = `toolErr${code}`;
      const hits = [...main.matchAll(new RegExp(`${key}: "([^"]+)"`, "g"))].map(
        (m) => m[1] ?? "",
      );
      assert.equal(hits.length, 2, `${key} must appear in both locale tables`);
      assert.match(
        hits[1] ?? "",
        /[一-鿿]/,
        `${key}'s zh label is not Chinese — it is "${hits[1]}"`,
      );
    }
  });
});
