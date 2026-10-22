#!/usr/bin/env node
/**
 * Set up one manual-test scenario in a THROWAWAY copy and open VS Code on it.
 *
 * Driving in place is what made `tests/` dirty after every gate and forced a
 * `git restore` into every TEST.md plus a residue-cleanup clause into the build
 * session's first step. A copy makes all three unnecessary: when you are done,
 * delete the directory.
 *
 * usage: pnpm test:manual <milestone>/<scenario> [--locale zh-cn]
 *   e.g. pnpm test:manual d1/1-protected-spans-agentic
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(repoRoot, "Lemmaria-design-doc", "tests");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { locale: { type: "string" } },
});

const target = positionals[0];
if (!target) {
  console.error(
    "usage: pnpm test:manual <milestone>/<scenario> [--locale zh-cn]",
  );
  process.exit(2);
}

const scenarioDir = join(testsRoot, ...target.split("/"));
if (!existsSync(scenarioDir)) {
  console.error(`no such scenario: ${scenarioDir}`);
  const milestone = target.split("/")[0];
  const milestoneDir = join(testsRoot, milestone);
  if (existsSync(milestoneDir)) {
    console.error(
      `scenarios in ${milestone}: ${(await readdir(milestoneDir)).join(", ")}`,
    );
  }
  process.exit(2);
}

// The workspace folder the operator opens. Scenarios keep their paper in
// `paper/`; a scenario with none (a pure regression sweep) opens its own dir.
const source = existsSync(join(scenarioDir, "paper"))
  ? join(scenarioDir, "paper")
  : scenarioDir;

const work = await mkdtemp(join(tmpdir(), "lemmaria-manual-"));
const dest = join(work, "paper");
await cp(source, dest, { recursive: true });

// Seed workspace settings if the scenario ships any. `manual.json` is a plain
// VS Code settings object; it lands as the copy's .vscode/settings.json so the
// operator never hand-sets a permission mode before starting.
//
// Precedence, deliberate: `manual.json` wins — it is the scenario stating what
// this test needs pinned. Failing that, a `.vscode/settings.json` the paper
// itself commits is KEPT, because clobbering it with `{}` would silently drop
// settings the fixture ships on purpose. The `{}` placeholder is only for a
// workspace that has neither.
const seed = join(scenarioDir, "manual.json");
const settings = join(dest, ".vscode", "settings.json");
if (existsSync(seed)) {
  await mkdir(join(dest, ".vscode"), { recursive: true });
  await cp(seed, settings);
} else if (!existsSync(settings)) {
  await mkdir(join(dest, ".vscode"), { recursive: true });
  await writeFile(settings, "{}\n", "utf8");
}

// Nothing is copied for the operator to write into: the write-up is reported by
// exception, in prose, and no scenario ships a sheet (ADR 0038 §1 retired the
// `RUN.md` template ADR 0035 §4 had introduced). Every file the operator reads
// is read-only, so the source-tree `TEST.md` path is what we print below.

// Where VS Code Stable keeps its user data, per platform.
function defaultUserDataDir() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? "", "Code");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code");
  }
  return join(homedir(), ".config", "Code");
}

// `--locale` is resolved by the MAIN process at startup, which drops it two
// different ways — we hit both. (1) With VS Code already running, `code` hands
// the request to an instance that chose its language long ago. A user-data-dir
// of our own forces a separate main process, since that is what VS Code keys
// its instance socket on. (2) But a COLD profile has no `languagepacks.json`
// yet: the main process resolves NLS before the pack index exists, falls back
// to English, and writes the index only for next time — so a fresh profile is
// English exactly once, which reads as the flag being ignored. Seeding the real
// profile's index fixes that; its translation paths point into the extensions
// dir, which `--user-data-dir` does NOT relocate, so a copy is valid as-is.
//
// Only when a locale is actually requested. Otherwise the operator gets their
// own editor — themes, keybindings, sign-ins — which is the point of F5 too.
const userDataDir = values.locale ? join(work, "user-data") : undefined;
if (userDataDir) {
  await mkdir(userDataDir, { recursive: true });
  const packIndex = join(defaultUserDataDir(), "languagepacks.json");
  if (existsSync(packIndex)) {
    await cp(packIndex, join(userDataDir, "languagepacks.json"));
  }
}

const args = [
  "--new-window",
  `--extensionDevelopmentPath=${join(repoRoot, "packages", "extension")}`,
  ...(values.locale
    ? [`--locale=${values.locale}`, `--user-data-dir=${userDataDir}`]
    : []),
  dest,
];

console.log(`scenario:  ${target}`);
console.log(`workspace: ${dest}`);
console.log(`guide:     ${join(scenarioDir, "TEST.md")}`);
if (userDataDir) {
  console.log(
    `profile:   throwaway, under the same dir — ${values.locale} needs its own,`,
  );
  console.log(
    "           so this window opens bare (no theme, no extensions, may ask",
  );
  console.log("           whether you trust the folder). That is expected.");
}
console.log(`when done: rm -rf "${work}"   (nothing to git restore)`);
console.log("");

// `code` is a shell wrapper on PATH, so a shell is required on Windows — but
// spawn(cmd, argsArray, {shell:true}) joins the args with bare spaces and hands
// cmd.exe the result with NO per-argument quoting, so a workspace path containing
// a space arrives as several arguments. (Node's DEP0190 warns about exactly this.)
// Quote them here and pass ONE command string instead.
//
// The ARGUMENTS are quoted; the command name deliberately is NOT. Quoting a bare
// name that cmd.exe has to resolve through PATH leaves `%0` as the literal
// `"code"`, so `%~dp0` inside code.cmd degrades to the CURRENT DIRECTORY — and
// the wrapper then looks for `<cwd>\..\Code.exe` and exits 9009. Quoting `code`
// buys nothing anyway (no spaces), and quoting the args alone is what actually
// protects the paths. Do not "fix" this by re-quoting the name.
const command = ["code", ...args.map((a) => `"${a}"`)].join(" ");
const child = spawn(command, { stdio: "inherit", shell: true });

// `error` does NOT fire when `code` is missing under a shell: cmd.exe itself
// starts fine and only fails to resolve `code` internally. Without an exit
// handler the script also drains its event loop and exits 0 — reporting success
// while nothing opened. Propagate the child's status instead.
child.on("error", (err) => {
  console.error(`could not launch VS Code: ${err.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  if (code !== 0) {
    console.error("");
    console.error(`VS Code's launcher exited with status ${code}.`);
    console.error(
      "Is the `code` command on PATH? (VS Code: Shell Command: Install 'code' command)",
    );
    console.error(`The prepared workspace is still at: ${dest}`);
    process.exitCode = 1;
  }
});
