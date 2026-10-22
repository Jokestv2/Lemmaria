/** Invariant 1's LOAD-BEARING guard: fail if any source file in the pure
 *  packages mentions a vscode import.
 *
 *  This file used to call itself a backstop and dependency-cruiser "the
 *  primary check". That was refuted at U0 (verified via
 *  `depcruise --output-type json`): `import ... from "vscode"` resolves into
 *  node_modules/@types/vscode, which .dependency-cruiser.cjs's `exclude`
 *  drops, so depcruise records no vscode edge at all and no rule matching
 *  `^vscode$` can ever fire. The cruiser earns its place on the non-vscode
 *  rules; this grep is what actually enforces the invariant, because it
 *  scans source text, covers all four import syntaxes, and is
 *  deny-by-default over every packages/* except extension. Never weaken or
 *  disable it to get a gate green. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Fail-safe: every package except the extension is guarded, so new
// packages are covered without touching this file.
const GUARDED = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "extension")
  .map((d) => join("packages", d.name));
const PATTERN =
  /(from\s+["']vscode["'])|(import\s+["']vscode["'])|(require\(\s*["']vscode["']\s*\))|(import\s*\(\s*["']vscode["']\s*\))/;

// The extension package is otherwise exempt, but its webview bundle runs in
// the browser context and must be `vscode`-free (ADR 0011 / invariant 1).
const WEBVIEW_SOURCES = [
  join("packages", "extension", "src", "webview"),
  join("packages", "extension", "src", "webview-protocol.ts"),
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) {
      yield p;
    }
  }
}

const failures = [];
for (const pkg of GUARDED) {
  for (const file of walk(pkg)) {
    if (PATTERN.test(readFileSync(file, "utf8"))) failures.push(file);
  }
}
for (const target of WEBVIEW_SOURCES) {
  if (!existsSync(target)) continue;
  const files = statSync(target).isDirectory() ? walk(target) : [target];
  for (const file of files) {
    if (PATTERN.test(readFileSync(file, "utf8"))) failures.push(file);
  }
}

if (failures.length > 0) {
  console.error("vscode import found outside packages/extension:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("check-vscode-imports: OK");
