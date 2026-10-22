/** Regenerates `packages/extension/THIRD-PARTY-NOTICES.md`.
 *
 *  Lemmaria ships a single bundled `dist/extension.cjs` plus `dist/webview.js`,
 *  and esbuild strips every licence header on the way in. MIT, ISC, BSD and
 *  Apache-2.0 all require their copyright and permission notices to travel with
 *  a redistribution, so what the bundles absorb has to be named somewhere — and
 *  this file is that somewhere.
 *
 *  It reads `packages/extension/.esbuild-meta.json`, which `esbuild.mjs` writes
 *  with `metafile: true`, so the list is **what actually ended up in the
 *  bundles**. Reading `package.json` dependencies instead would be wrong in
 *  both directions: it would name devDependencies that never ship, and miss
 *  transitive packages a deep import pulled in.
 *
 *  The hand-written sections (brand assets, Codicons) live in HEADER below and
 *  are NOT generated — edit them here.
 *
 *  Run: `node scripts/generate-third-party-notices.mjs`, which `package:ext`
 *  does for you. `--check` exits non-zero if the file is stale instead of
 *  writing it. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const META = join(root, "packages/extension/.esbuild-meta.json");
const OUT = join(root, "packages/extension/THIRD-PARTY-NOTICES.md");
const check = process.argv.includes("--check");

const HEADER = `# Third-party notices

Lemmaria itself is licensed under the PolyForm Strict License 1.0.0 — see \`LICENSE.txt\`. The
notices below cover material that is **not** ours and travels inside this package.

## Lemmaria brand assets

The Lemmaria logo (the three layered pebbles) and wordmark are original brand assets and are **not**
licensed to you by \`LICENSE.txt\`, which grants no rights in them. They remain subject to the
ownership and permissions of the supplied Lemmaria logo pack.

## Microsoft Codicons

Lemmaria's interface uses VS Code's own built-in theme icons through the \`$(name)\` syntax — those
are provided by the editor, not redistributed here.

The visual design pack this extension's artwork is drawn from also contains icons adapted from
**Microsoft Codicons** (https://github.com/microsoft/vscode-codicons), licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
**None of those adapted files ships in this package** — the extension bundles only the Lemmaria
brand marks listed above. This notice is here so the attribution already has a home the moment a
Codicon-derived asset is added. Adaptation in the source pack was limited to semantic filenames,
accessible labels, \`currentColor\` substitution, and uniform 1.5× scaling of the 16 px grid; icon
path geometry is unchanged. This use does not imply endorsement by Microsoft.

## PDFium (\`dist/pdfium.wasm\`)

Lemmaria renders pages of a compiled PDF with a WebAssembly build of **PDFium**
(https://pdfium.googlesource.com/pdfium/), delivered by the \`@embedpdf/pdfium\`
package and shipped in this extension as the copied asset \`dist/pdfium.wasm\`.

**It is attributed by hand, here, and that is deliberate.** Every other entry in
this file is generated from esbuild's metafile, which lists what ended up
*inside* a bundle. A copied asset never enters a bundle, so it never appears in
the metafile — and an attribution that depended on the generator would silently
go missing.

The binary is licensed under the **BSD 3-Clause License**:

> Copyright 2014 PDFium Authors. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are
> met:
>
>    * Redistributions of source code must retain the above copyright
> notice, this list of conditions and the following disclaimer.
>    * Redistributions in binary form must reproduce the above
> copyright notice, this list of conditions and the following disclaimer
> in the documentation and/or other materials provided with the
> distribution.
>    * Neither the name of Google Inc. nor the names of its
> contributors may be used to endorse or promote products derived from
> this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
> "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
> LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
> A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
> OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
> LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
> DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
> THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
> (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

PDFium bundles third-party components of its own, and the upstream package's
\`LICENSE.pdfium\` reproduces the **Apache License, Version 2.0**
(https://www.apache.org/licenses/LICENSE-2.0) alongside the notice above for
those components. Both apply to the shipped binary.

The \`@embedpdf/pdfium\` JavaScript wrapper itself is MIT-licensed and is
bundled, so it is listed with the generated entries below.
`;

/** A metafile input path looks like
 *  `../../node_modules/.pnpm/yaml@2.8.1/node_modules/yaml/dist/index.js`
 *  (pnpm) or `../../node_modules/yaml/dist/index.js` (hoisted). Return the
 *  package directory and its name for either, or null for our own source. */
function packageOf(inputPath) {
  const marker = "node_modules/";
  const last = inputPath.lastIndexOf(marker);
  if (last === -1) return null;
  const after = inputPath.slice(last + marker.length);
  const parts = after.split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  const dir = resolve(
    root,
    "packages/extension",
    inputPath.slice(0, last + marker.length),
    name,
  );
  return existsSync(join(dir, "package.json")) ? { name, dir } : null;
}

const LICENCE_FILENAMES = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.(md|txt))?$/i;

function licenceTextOf(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => LICENCE_FILENAMES.test(n));
  if (!hit) return null;
  try {
    return readFileSync(join(dir, hit), "utf8").trim();
  } catch {
    return null;
  }
}

if (!existsSync(META)) {
  console.error(
    "generate-third-party-notices: no .esbuild-meta.json — run `pnpm build` in packages/extension first.",
  );
  process.exit(1);
}

const meta = JSON.parse(readFileSync(META, "utf8"));
const found = new Map();
for (const input of Object.keys(meta.inputs)) {
  const pkg = packageOf(input);
  if (!pkg || found.has(pkg.name)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const licence =
    typeof manifest.license === "string"
      ? manifest.license
      : (manifest.license?.type ?? "UNKNOWN");
  const repo =
    typeof manifest.repository === "string"
      ? manifest.repository
      : (manifest.repository?.url ?? null);
  found.set(pkg.name, {
    version: manifest.version ?? "",
    licence,
    text: licenceTextOf(pkg.dir),
    repo: repo ? repo.replace(/^git[+]/, "").replace(/[.]git$/, "") : null,
  });
}

const packages = [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
const missing = packages.filter(([, p]) => !p.text || p.licence === "UNKNOWN");

const FENCE = "```";
const lines = ["", "## Bundled open-source packages", ""];

if (packages.length === 0) {
  lines.push("No third-party package is bundled into `dist/`.");
} else {
  lines.push(
    `\`dist/extension.cjs\` and \`dist/webview.js\` are bundles: the ${packages.length} packages below are compiled into them, and esbuild strips their licence headers in the process. Their full licence texts are reproduced here, which is what MIT, ISC, BSD and Apache-2.0 each ask of a redistribution. Generated from the build's own esbuild metafile by \`scripts/generate-third-party-notices.mjs\` — do not edit this section by hand.`,
    "",
  );
  for (const [name, p] of packages)
    lines.push(`- **${name}** ${p.version} — ${p.licence}`);
  lines.push("", "---", "");
  for (const [name, p] of packages) {
    lines.push(`### ${name} ${p.version}`, "", p.licence, "");
    if (p.text) {
      lines.push(FENCE, p.text, FENCE, "");
    } else {
      // Some packages declare a licence in package.json but ship no licence
      // FILE — common for monorepo members, which keep one at the repo root.
      // Naming the declared licence and pointing at the upstream source is the
      // most that can honestly be reproduced from what was actually published.
      const where = p.repo ? `; the full text is at ${p.repo}.` : ".";
      lines.push(
        `_This package declares **${p.licence}** in its \`package.json\` but ships no licence file${where}_`,
        "",
      );
    }
  }
}

const body = lines.join("\n");

const next = HEADER + body;
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";

if (check) {
  if (current !== next) {
    console.error(
      "generate-third-party-notices: THIRD-PARTY-NOTICES.md is STALE — run `node scripts/generate-third-party-notices.mjs`.",
    );
    process.exit(1);
  }
  console.log(
    `generate-third-party-notices: OK — ${packages.length} bundled packages, up to date`,
  );
} else {
  writeFileSync(OUT, next);
  console.log(
    `generate-third-party-notices: wrote ${packages.length} bundled packages`,
  );
}

if (missing.length > 0) {
  console.warn(
    `generate-third-party-notices: ${missing.length} package(s) ship no licence file or declare none — ${missing
      .map(([n]) => n)
      .join(", ")}`,
  );
}
