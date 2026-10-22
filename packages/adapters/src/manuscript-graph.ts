/**
 * The `ManuscriptGraphReader` every real host wires (X5, ADR 0074 §4) — the
 * entry's extension chooses the adapter, and an extension no adapter covers
 * answers `undefined`, which the driver reads as *"fall back to the suffix
 * glob, and say so"*.
 *
 * It lives here rather than in each host for the same reason
 * `protectedSpansForFile` does: the extension, the CLI eval driver and the
 * tests must not be able to disagree about which files a paper is made of.
 *
 * **Why the harness cannot do this itself.** The walk is `LatexProject`'s, and
 * the harness must have zero dependency on `@lemmaria/adapters` (invariant 1)
 * — that is what lets the same harness run server-side. So the capability is
 * injected as a function, exactly as `ProtectedSpanReader` is.
 */

import type { ManuscriptGraph } from "@lemmaria/harness";
import { LatexProject } from "./latex/project.js";
import { MarkdownAdapter } from "./markdown/adapter.js";

/** The subset of a workspace read the graph needs. */
interface GraphReader {
  readFile(relPath: string): Promise<string>;
}

export async function manuscriptGraphFor(
  entry: string,
  read: (relPath: string) => Promise<string>,
): Promise<ManuscriptGraph | undefined> {
  const reader: GraphReader = { readFile: read };
  try {
    if (/\.(tex|latex)$/i.test(entry)) {
      const project = await LatexProject.load(reader, entry);
      return {
        files: project.readingOrder(),
        // A declared target that did not read — an `\input` or a `.bib`. The
        // paper still reviews; the panel says what it read without.
        missing: [...project.missingInputs, ...project.missingBibs],
      };
    }
    if (/\.(md|markdown)$/i.test(entry)) {
      const adapter = await MarkdownAdapter.load(reader, entry);
      return {
        files: [entry, ...adapter.bibliographyPaths()],
        missing: [...adapter.missingBibliographies()],
      };
    }
  } catch {
    // An unreadable entry, or a parse that fell over. `undefined` is the
    // honest answer — the driver has its own no-manuscript precondition, and
    // guessing a file list here would put files in front of a reviewer that
    // the paper never claimed.
    return undefined;
  }
  return undefined;
}
