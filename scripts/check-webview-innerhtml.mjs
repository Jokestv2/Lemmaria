/** Backstop for D3 / ADR 0039 §5: fail if any webview source parses a string
 *  into DOM. The webview renders MODEL OUTPUT, and its CSP carries no
 *  'unsafe-inline' to fall back on, so an innerHTML shortcut here is a
 *  security defect rather than a style choice.
 *
 *  This is a BACKSTOP, not the gate. The gate is a DOM assertion — feed
 *  `<script>` through the renderer and assert no element appears
 *  (`test-webview/markdown.test.ts`) — because ADR 0037 §4 is right that
 *  matching the source which builds a DOM asserts the code, not its output.
 *  What a DOM test structurally cannot do is cover a line nobody has written
 *  yet, over a whole tree, which is exactly what this does and why both exist.
 *  Same relationship `check-vscode-imports.mjs` has to dependency-cruiser.
 *
 *  Deny-by-default with NO allowlist, and it shipped that way: the baseline
 *  was already clean, so there is nothing to grandfather and nothing to argue
 *  about later. Keep it that way — if a webview file needs one of these, the
 *  answer is to build nodes instead. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The webview bundle is the only browser context in the product, so it is the
// only place these sinks can reach a DOM. `webview-view.ts` builds the host
// page's HTML as a string by design and is deliberately NOT in scope.
const GUARDED = [join("packages", "extension", "src", "webview")];

// `\+?=` matters more than it looks: `el.innerHTML += x` is the most
// idiomatic form of the mistake, and a guard that lets the common case through
// is not deny-by-default. `parseFromString` and `setHTML(Unsafe)` are the other
// real string→DOM sinks, which the doc comment above already claims to cover.
const PATTERN =
  /\.(inner|outer)HTML\s*\+?=|\[\s*["'](inner|outer)HTML["']\s*\]\s*\+?=|\.insertAdjacentHTML\s*\(|\.parseFromString\s*\(|\.setHTML(Unsafe)?\s*\(|document\s*\.\s*write(ln)?\s*\(|createContextualFragment\s*\(/;

/** Comments are stripped first, so prose ABOUT the rule cannot trip it — the
 *  same discipline `check-mixed-language-strings.mjs` applies. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
for (const target of GUARDED) {
  if (!existsSync(target)) continue;
  for (const file of walk(target)) {
    if (PATTERN.test(stripComments(readFileSync(file, "utf8")))) {
      failures.push(file);
    }
  }
}

if (failures.length > 0) {
  console.error(
    "string-to-DOM parsing found in the webview — build nodes instead:",
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("check-webview-innerhtml: OK");
