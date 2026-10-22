/**
 * Built-in actions ship as YAML files in <package root>/actions/ — defined with
 * the same schema and loaded through the same loader as user/project actions
 * (schema spec design principle 2). Both src/ and dist/ sit one level below the
 * package root, so ../../actions/ resolves identically from tests and builds.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActionFile,
  type ActionLoadError,
  type LoadedAction,
  loadActionSet,
} from "./loader.js";

/**
 * Lazy on purpose: a top-level `import.meta.url` would evaluate (and crash)
 * inside a CJS bundle (esbuild rewrites it to undefined). Bundled hosts must
 * not call this — they feed the YAML through loadActionSet themselves (the
 * extension's builtin-actions.ts does).
 */
export function builtinActionsDir(): string {
  return fileURLToPath(new URL("../../actions/", import.meta.url));
}

export async function loadBuiltinActions(): Promise<{
  actions: LoadedAction[];
  errors: ActionLoadError[];
}> {
  const dir = builtinActionsDir();
  const entries = await readdir(dir);
  const files: ActionFile[] = await Promise.all(
    entries
      .filter(
        (name) =>
          name.endsWith(".yaml") ||
          name.endsWith(".yml") ||
          name.endsWith(".json"),
      )
      .sort()
      .map(async (name) => {
        const path = join(dir, name);
        return { path, content: await readFile(path, "utf8") };
      }),
  );
  return loadActionSet({ "built-in": files });
}
