/** Publish the extension to the Visual Studio Marketplace.
 *
 *  `vsce publish` is outward-facing and IRREVERSIBLE: a version number, once
 *  taken, is taken forever, and a listing people have already seen is expensive
 *  to correct. P1's D10 says publishing "is not scripted as a default" and
 *  stays the operator's call — so this script's default is a DRY RUN. It runs
 *  every check and builds the package; `--publish` is the only thing that
 *  uploads, and it is never implied.
 *
 *  What it does, in order — any failure stops the run:
 *
 *    1. Read the manifest. `publisher`, `name`, `version` must be present and
 *       `version` must be plain semver. The version is READ, never written:
 *       bumping it is a decision, made in `package.json` by a human.
 *    2. The working tree must be clean (`--allow-dirty` to override). Publishing
 *       an uncommitted tree means the artifact on the Marketplace corresponds to
 *       no commit anywhere.
 *    3. `CHANGELOG.md` must carry a `## [<version>]` entry. The Marketplace's
 *       Changelog tab renders this file; a release with no entry in it ships a
 *       changelog that silently omits the version being installed.
 *    4. Ask the Marketplace whether `<publisher>.<name>@<version>` already
 *       exists. "Extension not found" is the expected answer on a first publish
 *       and is not an error; an already-published VERSION is fatal.
 *    5. The gate: `build`, `test`, `check:boundaries`, `lint`, `typecheck`.
 *       `test:ext` boots a real VS Code (slow, ~280 MB on first run) and is
 *       opt-in via `--with-ext-tests`.
 *    6. `package:ext` — builds, regenerates THIRD-PARTY-NOTICES.md, runs
 *       `vsce package`, then asserts the archive's file list
 *       (`check-vsix-contents.mjs`).
 *    7. Re-open the built `.vsix` and confirm the version and publisher inside
 *       it match the manifest. The archive is what gets uploaded, so the
 *       archive is what gets checked.
 *    8. With `--publish`: upload THAT archive via `--packagePath`, so the bytes
 *       published are the bytes just verified rather than a fresh repack nobody
 *       has looked at.
 *
 *  THE TOKEN. The PAT is read from `.env` at the app root (`VSCE_PAT`, or
 *  `VSCE_PUBLISH_TOKEN`) and handed to `vsce` through the child process's
 *  ENVIRONMENT — never as an argument, which would put it in the process list
 *  and the shell history, and never printed. `.env` is gitignored. Child output
 *  is filtered through a redactor as a second line of defence, so a token
 *  echoed by a future `vsce` cannot reach the terminal or a CI log.
 *
 *  Usage, from the app root:
 *
 *    pnpm publish:ext                      # dry run: every check + the package
 *    pnpm publish:ext --with-ext-tests     # ... and the extension-host suite
 *    pnpm publish:ext --publish            # actually upload
 *    pnpm publish:ext --publish --allow-dirty
 *    pnpm publish:ext --skip-gate          # package only; for a re-publish of
 *                                          # a build whose gate already passed
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "packages", "extension");
const WIN = process.platform === "win32";

const argv = new Set(process.argv.slice(2));
const DO_PUBLISH = argv.has("--publish");
const WITH_EXT_TESTS = argv.has("--with-ext-tests");
const SKIP_GATE = argv.has("--skip-gate");
const ALLOW_DIRTY = argv.has("--allow-dirty");

for (const flag of argv)
  if (
    !["--publish", "--with-ext-tests", "--skip-gate", "--allow-dirty"].includes(
      flag,
    )
  )
    fail(`unknown flag: ${flag}`);

/* ------------------------------------------------------------------ output */

let secret = null; // set once the PAT is read; never logged, only redacted.

function redact(text) {
  if (!secret || !text) return text;
  return text.split(secret).join("***REDACTED***");
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    OK   ${msg}`);
const note = (msg) => console.log(`    ..   ${msg}`);

function fail(msg) {
  console.error(`\nPUBLISH ABORTED — ${redact(String(msg))}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------- shell */

/** Run a command. Arguments are passed as an array and never concatenated into
 *  a shell string beyond the quoting `shell: true` needs on Windows, where pnpm
 *  is a `.cmd`.
 *
 *  Three output modes, and the distinction is the token:
 *    - `capture`  — buffered and returned, for output this script parses.
 *    - `redacted` — buffered, run through the redactor, then written out. Used
 *      for the ONE command that is handed the PAT, so a token a future `vsce`
 *      decides to echo cannot reach the terminal or a CI log.
 *    - default    — inherited, so a long build streams live. Safe because these
 *      commands are never given the token in the first place. */
function run(cmd, args, { env = {}, capture = false, redacted = false } = {}) {
  const line = WIN
    ? [cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" ")
    : cmd;
  const piped = capture || redacted;
  const result = spawnSync(WIN ? line : cmd, WIN ? [] : args, {
    cwd: ROOT,
    shell: WIN,
    encoding: "utf8",
    stdio: piped ? "pipe" : "inherit",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
  const out = redact(result.stdout ?? "");
  const err = redact(result.stderr ?? "");
  if (redacted) {
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
  }
  return { status: result.status, stdout: out, stderr: err };
}

const pnpm = (args, opts) => run("pnpm", args, opts);

/* --------------------------------------------------------------- 1. manifest */

step(1, "Manifest");

const manifestPath = join(EXT_DIR, "package.json");
if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const { publisher, name, version } = manifest;
if (!publisher) fail("package.json has no `publisher`");
if (!name) fail("package.json has no `name`");
if (!version) fail("package.json has no `version`");
if (manifest.private === true) fail('package.json sets "private": true');
if (!/^\d+\.\d+\.\d+$/.test(version))
  fail(
    `version "${version}" is not plain semver. The Marketplace takes x.y.z; pre-release tags are not published from here.`,
  );

const EXT_ID = `${publisher}.${name}`;
ok(`${EXT_ID}@${version}`);
note(`version is read, never written — bump it in ${manifestPath}`);

/* ------------------------------------------------------------ 2. clean tree */

step(2, "Working tree");

const status = run("git", ["status", "--porcelain"], { capture: true });
if (status.status !== 0) fail("git status failed — is this a git checkout?");
const dirty = status.stdout.split("\n").filter((l) => l.trim());
if (dirty.length === 0) {
  ok("clean");
} else if (ALLOW_DIRTY) {
  note(`${dirty.length} uncommitted path(s) — allowed by --allow-dirty:`);
  for (const l of dirty.slice(0, 20)) console.log(`         ${l}`);
} else {
  console.error("\n  uncommitted changes:");
  for (const l of dirty.slice(0, 20)) console.error(`    ${l}`);
  fail(
    "the working tree is dirty. Publishing it puts an artifact on the " +
      "Marketplace that matches no commit. Commit, or pass --allow-dirty.",
  );
}

const sha = run("git", ["rev-parse", "--short", "HEAD"], { capture: true });
if (sha.status === 0) note(`HEAD ${sha.stdout.trim()}`);

/* -------------------------------------------------------------- 3. changelog */

step(3, "CHANGELOG entry");

const changelogPath = join(EXT_DIR, "CHANGELOG.md");
if (!existsSync(changelogPath)) fail(`no CHANGELOG.md at ${changelogPath}`);
const changelog = readFileSync(changelogPath, "utf8");
const heading = new RegExp(
  `^##\\s*\\[?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`,
  "m",
);
if (!heading.test(changelog))
  fail(
    `CHANGELOG.md has no "## [${version}]" entry. The Marketplace's Changelog tab renders this file; shipping a version it does not mention is a changelog that lies by omission.`,
  );
ok(`"## [${version}]" found`);

/* ------------------------------------------------ 4. not already published */

step(4, "Marketplace");

const show = pnpm(["exec", "vsce", "show", EXT_ID, "--json"], {
  capture: true,
});
const showText = `${show.stdout}${show.stderr}`;

if (/not found/i.test(showText)) {
  ok(`${EXT_ID} is not published yet — this would be the FIRST publish`);
  note(
    `a first publish fixes the extension id permanently; "${EXT_ID}" cannot be renamed afterwards`,
  );
} else if (show.status === 0) {
  let published = [];
  try {
    const json = JSON.parse(show.stdout);
    published = (json.versions ?? [])
      .map((v) => v.version)
      .filter((v) => typeof v === "string");
  } catch {
    note("could not parse `vsce show --json`; falling back to a text scan");
    published = showText.includes(version) ? [version] : [];
  }
  if (published.includes(version))
    fail(
      `${EXT_ID}@${version} is ALREADY published. A version number cannot be reused or overwritten — bump \`version\` in package.json and add a CHANGELOG entry for the new one.`,
    );
  ok(
    `${EXT_ID} exists; ${version} is not among its ${published.length} version(s)`,
  );
  if (published.length) note(`latest published: ${published[0]}`);
} else {
  note("could not reach the Marketplace to check for a version clash");
  note("(offline? the publish step below would fail too)");
  if (DO_PUBLISH)
    fail(
      "refusing to publish without confirming the version is free. " +
        "Re-run when the Marketplace is reachable.",
    );
}

/* -------------------------------------------------------------- 5. the gate */

const GATE = [
  ["build", ["build"]],
  ["test", ["test"]],
  ["check:boundaries", ["check:boundaries"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
];
if (WITH_EXT_TESTS) GATE.push(["test:ext", ["test:ext"]]);

step(5, `Gate (${SKIP_GATE ? "SKIPPED" : GATE.map(([n]) => n).join(" · ")})`);

if (SKIP_GATE) {
  note("--skip-gate: only the package step below will run");
  if (DO_PUBLISH)
    note("publishing a build whose gate was not run in THIS invocation");
} else {
  for (const [label, args] of GATE) {
    console.log(`\n  --- pnpm ${args.join(" ")} ---`);
    const r = pnpm(args);
    if (r.status !== 0) fail(`\`pnpm ${args.join(" ")}\` failed`);
    ok(label);
  }
  if (!WITH_EXT_TESTS)
    note("test:ext not run (boots a real VS Code) — add --with-ext-tests");
}

/* ----------------------------------------------------------- 6. the package */

step(6, "Package");

console.log("\n  --- pnpm package:ext ---");
const pkg = pnpm(["package:ext"]);
if (pkg.status !== 0) fail("`pnpm package:ext` failed");
ok("packaged, and check-vsix-contents passed");

/* ------------------------------------------------- 7. verify what was built */

step(7, "Verify the archive");

const vsixPath = join(EXT_DIR, `${name}-${version}.vsix`);
if (!existsSync(vsixPath))
  fail(
    `expected ${vsixPath} but it is not there. Did \`vsce package\` write a different name?`,
  );

const buf = readFileSync(vsixPath);
const inner = readZipEntry(buf, "extension/package.json");
if (!inner) fail("the .vsix contains no extension/package.json");
const packaged = JSON.parse(inner.toString("utf8"));
if (packaged.version !== version)
  fail(
    `the archive carries version ${packaged.version}, the manifest says ${version}`,
  );
if (packaged.publisher !== publisher)
  fail(
    `the archive carries publisher ${packaged.publisher}, the manifest says ${publisher}`,
  );
ok(`${vsixPath.replace(ROOT, ".")} — ${(buf.length / 1024).toFixed(0)} KB`);
ok(`archive says ${packaged.publisher}.${packaged.name}@${packaged.version}`);
note(`categories: ${(packaged.categories ?? []).join(", ")}`);
note(`keywords:   ${(packaged.keywords ?? []).join(", ")}`);

/* ---------------------------------------------------------------- 8. publish */

if (!DO_PUBLISH) {
  console.log(`
────────────────────────────────────────────────────────────────────────
DRY RUN — nothing was uploaded.

  would publish : ${EXT_ID}@${version}
  from          : ${vsixPath}
  listing       : https://marketplace.visualstudio.com/items?itemName=${EXT_ID}

Install it locally and look at it first:

  code --install-extension "${vsixPath}" --force
  code --uninstall-extension ${EXT_ID}

When it is right, re-run with --publish. That step cannot be undone.
────────────────────────────────────────────────────────────────────────
`);
  process.exit(0);
}

step(8, "Publish");

secret = readToken();
ok("PAT loaded from .env (passed to vsce via the environment, never argv)");

const publishArgs = [
  "exec",
  "vsce",
  "publish",
  "--no-dependencies",
  // `repository` is deliberately absent — forced while the GitHub repo was
  // private, and an operator decision since it went public. See the assertions
  // in packages/extension/test/manifest.test.ts.
  "--allow-missing-repository",
  "--packagePath",
  vsixPath,
];

console.log(`\n  --- vsce publish ${EXT_ID}@${version} ---`);
const published = pnpm(publishArgs, {
  env: { VSCE_PAT: secret },
  redacted: true,
});
if (published.status !== 0) fail("`vsce publish` failed");

console.log(`
────────────────────────────────────────────────────────────────────────
PUBLISHED — ${EXT_ID}@${version}

  https://marketplace.visualstudio.com/items?itemName=${EXT_ID}

The listing takes a few minutes to appear and to build for each platform.
galleryBanner is painted only by the web Marketplace, so this is the first
moment it can be looked at (P1 row E2's undrivable half).
────────────────────────────────────────────────────────────────────────
`);

/* ------------------------------------------------------------------ helpers */

/** Read the PAT from `.env`. Returns the token; the caller must never log it.
 *  `VSCE_PAT` is vsce's own variable name and wins; `VSCE_PUBLISH_TOKEN` is
 *  accepted as the name this repo's operator already uses. */
function readToken() {
  const fromEnv = process.env.VSCE_PAT || process.env.VSCE_PUBLISH_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();

  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath))
    fail(
      "no PAT. Put `VSCE_PAT=<token>` in .env at the app root (it is " +
        "gitignored), or set VSCE_PAT in the environment.",
    );

  const parsed = new Map();
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    )
      value = value.slice(1, -1);
    parsed.set(m[1], value);
  }

  const token = parsed.get("VSCE_PAT") || parsed.get("VSCE_PUBLISH_TOKEN");
  if (!token)
    fail(
      ".env has neither VSCE_PAT nor VSCE_PUBLISH_TOKEN. The PAT needs " +
        "Marketplace → Manage scope, over all accessible organizations.",
    );
  return token;
}

/** Read one entry out of a ZIP (a `.vsix` is a ZIP) by walking the central
 *  directory, then inflating that entry's local record. Same no-dependency
 *  approach as check-vsix-contents.mjs, which reads names only. */
function readZipEntry(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) fail("the .vsix is not a ZIP archive");

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50)
      fail(`central directory entry ${i} has a bad signature`);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString("utf8", offset + 46, offset + 46 + nameLen);

    if (entryName === wanted) {
      const lhNameLen = zip.readUInt16LE(localOffset + 26);
      const lhExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lhNameLen + lhExtraLen;
      const body = zip.subarray(start, start + compressedSize);
      if (method === 0) return body;
      if (method === 8) return inflateRawSync(body);
      fail(`${wanted} uses unsupported ZIP compression method ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
