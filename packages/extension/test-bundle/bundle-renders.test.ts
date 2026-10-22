// @vitest-environment node
/**
 * V3 (O19): the BUNDLE renders a page — the `import.meta.url` shim, guarded.
 *
 * esbuild lowers `import.meta.url` to `{}` when it bundles ESM into CJS, and
 * **suppresses the warning for code under `node_modules`**. So a vendored
 * package whose loader reads it fails at runtime with nothing said at build
 * time. `@embedpdf/pdfium` is exactly that package; `esbuild.options.mjs`
 * carries S6's measured fix (`define` + `inject`), and this is what stops the
 * pair being removed as dead weight.
 *
 * It bundles `probe.ts` with the **same** options the extension is built with —
 * a test on its own options would prove nothing about what ships — and runs the
 * result under plain Node.
 *
 * Watched fail by hand once, at T10: removing either half of the pair makes
 * every case here fail with `TypeError: Cannot read properties of undefined
 * (reading 'startsWith')` from `init`. The same failure was also observed
 * naturally in the ext-host suite before the pair was added, since
 * `package.json`'s `main` points at `dist/extension.cjs`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The extension package is CJS, so this .mjs sibling is imported by URL.
import { extensionBuildOptions } from "../esbuild.options.mjs";

const run = promisify(execFile);

/**
 * The PNG's own declared width and height, read from its IHDR chunk.
 *
 * Inline rather than through `fast-png`, deliberately: the extension package
 * has NO dependencies (both workspace packages are devDependencies esbuild
 * inlines), and adding a decoder just for this test would be the first —
 * which the acceptance gate explicitly forbids. Eight bytes at a fixed offset
 * is cheaper than a dependency, and it reads the real file either way.
 */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // 8-byte signature, then the IHDR chunk: 4 length + 4 type, then w and h.
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PDF = join(
  pkgRoot,
  "..",
  "adapters",
  "test",
  "fixtures",
  "simple-en",
  "main.pdf",
);
const WASM = join(pkgRoot, "dist", "pdfium.wasm");

let dir: string;
let probe: string;

beforeAll(async () => {
  // `dist/pdfium.wasm` is produced by `esbuild.mjs`'s copy step, so this file
  // is the one test in `pnpm test` that needs a build first. The gate runs
  // `install && build && test` and is unaffected; a clean checkout running
  // `pnpm test` alone would otherwise fail three cases on a bare ENOENT that
  // names neither the cause nor the fix.
  if (!existsSync(WASM)) {
    throw new Error(
      `${WASM} is missing — run \`pnpm build\` before \`pnpm test\`: the WASM is copied into dist/ by the extension's esbuild step, not checked in.`,
    );
  }
  dir = await mkdtemp(join(tmpdir(), "lemmaria-bundle-"));
  probe = join(dir, "probe.cjs");
  await build({
    ...extensionBuildOptions,
    entryPoints: [join(pkgRoot, "test-bundle", "probe.ts")],
    outfile: probe,
    // Only these two differ from what ships; everything that matters —
    // `format`, `platform`, `define`, `inject` — is the extension's own.
    sourcemap: false,
    metafile: false,
    absWorkingDir: pkgRoot,
  });
}, 120_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the CJS bundle can render a page (V3, O19)", () => {
  it("runs under plain Node and writes a real PNG at the width asked for", async () => {
    const out = join(dir, "page.png");
    await run(process.execPath, [probe, WASM, PDF, out]);
    const png = new Uint8Array(await readFile(out));
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const { width, height } = pngSize(png);
    expect(width).toBe(400);
    // A letter page is taller than it is wide, so the derived height proves
    // the aspect ratio survived the bundle too.
    expect(height).toBeGreaterThan(400);
  }, 120_000);

  it("the shipped options carry the shim, both halves", () => {
    // If either half is dropped, the case above stops passing — but naming
    // them here says WHICH change broke it, without anyone re-deriving S6.
    expect(extensionBuildOptions.define).toEqual({
      "import.meta.url": "__lemmaria_file_url",
    });
    expect(extensionBuildOptions.inject).toEqual(["./file-url-shim.mjs"]);
  });

  it("dist/pdfium.wasm exists after a build, and is real WebAssembly", async () => {
    const bytes = new Uint8Array(await readFile(WASM));
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
