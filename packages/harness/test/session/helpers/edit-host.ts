import type { SessionEditHost } from "../../../src/contracts/index.js";

/** An in-memory SessionEditHost over a plain file map, auto-applying. */
export function stubEditHost(files: Record<string, string>): SessionEditHost {
  return {
    policy: () => "auto_apply",
    readFile: async (file) => files[file],
    writeFile: async (file, content) => {
      files[file] = content;
    },
    fileExists: async (file) => files[file] !== undefined,
    requestDecisions: async (item) => item.edits.map(() => ({ accept: true })),
  };
}
