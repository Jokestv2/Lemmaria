import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FileReader {
  readFile(relPath: string): Promise<string>;
}

/** In-memory project for unit tests. */
export function memReader(files: Record<string, string>): FileReader {
  return {
    async readFile(relPath) {
      const content = files[relPath];
      if (content === undefined) throw new Error(`ENOENT: ${relPath}`);
      return content;
    },
  };
}

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Reads a fixture project from disk (tests only — src never touches fs). */
export function fixtureReader(project: string): FileReader {
  return {
    readFile: (relPath) =>
      readFile(path.join(fixturesRoot, project, relPath), "utf8"),
  };
}
