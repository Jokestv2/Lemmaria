/** P1 row O7: assert what the `.vsix` actually contains.
 *
 *  `.vscodeignore` is deny-by-default (exclude `**`, then re-admit), which is
 *  the only shape that keeps `packages/extension/.vscode-test/` — a ~280 MB
 *  VS Code download — out of a package. But a deny-by-default ignore file has
 *  the opposite failure mode: one missing `!` line and the package silently
 *  ships without an asset the manifest names, and the extension installs fine
 *  until someone opens the view whose icon is gone.
 *
 *  So both directions are asserted here, against the file list of the archive
 *  rather than against the ignore file's text. Same relationship
 *  `check-vscode-imports.mjs` has to dependency-cruiser: the guard reads the
 *  artifact, not the config that was supposed to produce it.
 *
 *  Run by `pnpm package:ext`, after `vsce package`. It reads the newest
 *  `.vsix` under `packages/extension/` and needs no dependency: a `.vsix` is a
 *  ZIP, and its central directory is enough to list the entries. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join("packages", "extension");

/** Entries that MUST be present — every one of them is named by the manifest,
 *  loaded by the bundle at runtime, or required to travel with the package by
 *  the licences of the third-party code bundled into it
 *  (`THIRD-PARTY-NOTICES.md`). */
const REQUIRED = [
  "extension/package.json",
  "extension/package.nls.json",
  "extension/package.nls.zh-cn.json",
  "extension/dist/extension.cjs",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  // V3 (ADR 0080 section 9): PDFium's WASM. Without it the renderer cannot
  // open a page in an installed extension, and nothing else would notice.
  "extension/dist/pdfium.wasm",
  "extension/media/lemmaria/icon.png",
  "extension/media/lemmaria/activity-bar.svg",
  "extension/media/lemmaria/lemmaria-light.svg",
  "extension/media/lemmaria/lemmaria-dark.svg",
  "extension/THIRD-PARTY-NOTICES.md",
];

/** The three files `vsce` RENAMES on its way into the archive, each given as
 *  the set of names that satisfy it.
 *
 *  Measured, not guessed: the first package run put `readme.md`,
 *  `changelog.md` and `LICENSE.txt` in the archive from `README.md`,
 *  `CHANGELOG.md` and `LICENSE` on disk — vsce lowercases the first two and
 *  gives the licence an extension, because the Marketplace looks them up by
 *  those names. `THIRD-PARTY-NOTICES.md` is not special-cased and
 *  travels verbatim, which is why it stays in the list above.
 *
 *  Stated as alternatives rather than pinned to today's spelling: the
 *  requirement is that the listing page, the changelog tab and the licence all
 *  ship, and a vsce release that stopped renaming would be a cosmetic change,
 *  not a regression. */
const REQUIRED_ANY = [
  ["extension/readme.md", "extension/README.md"],
  ["extension/changelog.md", "extension/CHANGELOG.md"],
  ["extension/LICENSE.txt", "extension/LICENSE", "extension/license.txt"],
];

/** Prefixes that must NOT appear. `.vscode-test/` is the expensive one; the
 *  rest are source and test material an installed extension has no use for. */
const FORBIDDEN_PREFIXES = [
  "extension/.vscode-test/",
  "extension/out/",
  "extension/src/",
  "extension/test/",
  "extension/test-webview/",
  // V3: the bundle smoke test and its probe entry are build-time only.
  "extension/test-bundle/",
  "extension/node_modules/",
];

/** Suffixes that must NOT appear anywhere in the archive. */
const FORBIDDEN_SUFFIXES = [".map", ".ts", ".tsbuildinfo"];

/** A `.vsix` is a ZIP. Walk the central directory backwards from the
 *  end-of-central-directory record and read each entry's name. No dependency,
 *  and it cannot be fooled by a local-header-only entry. */
function zipEntries(buf) {
  // End of central directory: signature 0x06054b50, within the last 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Error("not a ZIP archive: no end-of-central-directory");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50)
      throw new Error(`central directory entry ${i} has a bad signature`);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function newestVsix() {
  const found = readdirSync(EXT_DIR)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => ({ f, m: statSync(join(EXT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (found.length === 0) {
    console.error(
      `no .vsix found under ${EXT_DIR} — run \`pnpm package:ext\`, which packages first`,
    );
    process.exit(1);
  }
  return join(EXT_DIR, found[0].f);
}

const vsix = newestVsix();
const buf = readFileSync(vsix);
const names = zipEntries(buf);

const failures = [];

for (const required of REQUIRED)
  if (!names.includes(required))
    failures.push(
      `MISSING  ${required} — the manifest or the runtime needs it`,
    );

for (const alternatives of REQUIRED_ANY)
  if (!alternatives.some((name) => names.includes(name)))
    failures.push(
      `MISSING  none of ${alternatives.join(" / ")} is in the package`,
    );

for (const name of names) {
  for (const prefix of FORBIDDEN_PREFIXES)
    if (name.startsWith(prefix)) failures.push(`SHIPPED  ${name}`);
  for (const suffix of FORBIDDEN_SUFFIXES)
    if (name.endsWith(suffix)) failures.push(`SHIPPED  ${name}`);
}

// A package this large means `.vscodeignore` was not applied at all. The real
// package is well under a megabyte; the number is a smoke alarm, not a budget.
const MAX_BYTES = 8 * 1024 * 1024;
if (buf.length > MAX_BYTES)
  failures.push(
    `TOO BIG  ${(buf.length / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_BYTES / 1024 / 1024} MB smoke-alarm ceiling`,
  );

if (failures.length > 0) {
  console.error(`check-vsix-contents: ${vsix}`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `check-vsix-contents: OK — ${vsix}, ${names.length} entries, ${(buf.length / 1024).toFixed(0)} KB`,
);
