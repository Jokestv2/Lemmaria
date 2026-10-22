/**
 * The shipped curated venue set lives in <package root>/venues/ (ADR 0010),
 * exactly like built-in actions in <package root>/actions/. Both src/ and
 * dist/ sit one level below the package root, so ../../venues/ resolves
 * identically from tests and builds.
 *
 * Subpath export only ("@lemmaria/harness/bundled-venues"), NEVER the barrel:
 * esbuild rewrites import.meta.url when a module is pulled into the CJS
 * extension bundle (the recorded M3/M4 lesson). Bundled hosts pass their own
 * copied dir (the extension ships dist/venues/) instead of calling this.
 */

import { fileURLToPath } from "node:url";

/** Lazy on purpose — see the module comment. */
export function bundledVenuesDir(): string {
  return fileURLToPath(new URL("../../venues/", import.meta.url));
}
