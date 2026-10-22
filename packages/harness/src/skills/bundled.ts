/**
 * The shipped Writing Skill set's directory (ADR 0028).
 *
 * SUBPATH EXPORT ONLY (`@lemmaria/harness/bundled-skills`) — never the barrel,
 * for the reason `venue/bundled.ts` records: `import.meta.url` is rewritten to
 * empty when esbuild pulls the barrel into the CJS extension bundle. The
 * extension resolves its own copy under `extensionUri/dist/skills` instead;
 * this entry point exists for Node ESM consumers (the CLI, the tests).
 */
import { fileURLToPath } from "node:url";

export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../../skills/", import.meta.url));
}
