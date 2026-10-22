#!/usr/bin/env node
/**
 * The CLI's executable entry point (A6).
 *
 * `packages/cli` has shipped a `main(argv)` since M3 that nothing ever
 * executed — it was reachable only from vitest, so "re-runnable" was not
 * actually true of anything in it. A6 needs the flagship eval driver to be
 * runnable by the operator, so the package finally gets the shim it always
 * implied. Run `pnpm build` first: this loads the compiled `dist/`.
 */
import { main } from "../dist/main.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
