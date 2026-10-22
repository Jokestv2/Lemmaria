/**
 * CLI citation checking (M7; M8 adds Markdown). C1 offline: load the real
 * adapter (picked by entry extension — LaTeX \cite/.bib or Markdown [@key]/
 * frontmatter bibliography) over an FsWorkspace, extract cited keys + parsed
 * .bib entries, and run the harness consistency checker.
 */

import { loadAdapterFor } from "@lemmaria/adapters";
import { type Warning, checkCitationConsistency } from "@lemmaria/harness";
import { FsWorkspace } from "./run-action.js";

export async function runCliCitationCheck(opts: {
  root: string;
  entry: string;
}): Promise<Warning[]> {
  const ws = new FsWorkspace(opts.root, opts.entry);
  const adapter = await loadAdapterFor(ws, opts.entry);
  return checkCitationConsistency({
    citedKeys: adapter.citedKeys(),
    entries: adapter.bibEntries().map((e) => ({
      key: e.key,
      fields: e.fields,
      file: e.file,
      line: e.line,
    })),
    entryFile: opts.entry,
  });
}
