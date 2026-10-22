/**
 * The manuscript's own title, read out of its bytes (V2, ADR 0078 §5).
 *
 * **Why the harness needs it at all.** A reviewer searching the literature for
 * work near the paper it is reading will, sooner or later, be handed the paper
 * itself — and an identity-tier match puts it at rank one. A reviewer that then
 * cites it as prior work has been set up to fail by the tool. So the panel
 * withholds the manuscript from its own searches, and this is what it has to
 * withhold.
 *
 * Pure, and deliberately in its own file: it is a parser over text, with no
 * knowledge of panels, drivers or tools, and it is worth being able to read on
 * its own.
 *
 * **It is allowed to fail.** Titles live in macros, in front matter, in
 * `\input`-ed preambles, and sometimes nowhere a parser can see. `undefined` is
 * a real answer, and the driver records it as `own_title_unguarded / no_title`
 * rather than guessing — a wrong title would withhold somebody else's paper,
 * which is worse than withholding nothing.
 */

import type { Manuscript } from "./review-panel.js";

/**
 * Strip TeX comments, line by line.
 *
 * A `%` starts a comment unless it is escaped — `\%` is a literal percent sign,
 * which is common in a title about percentages. Nothing else about TeX's
 * comment rules matters here.
 */
function stripComments(tex: string): string {
  return tex
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") continue;
        // Count the backslashes immediately before it: an odd number means the
        // `%` is escaped, an even number (including zero) means it is not.
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * The balanced `{…}` group starting at `open`, without its braces.
 *
 * Brace-balanced rather than "up to the next `}`", because a real title is
 * full of groups: `\title{A Study of {Escherichia coli} in the Wild}` would
 * otherwise come back cut at the first inner brace.
 *
 * `undefined` when the group never closes, which is a malformed source — and a
 * malformed source is a title this function does not have.
 */
function balancedGroup(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      // An escaped brace is a character, not a delimiter.
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}

/** Skip an optional `[…]` argument and any whitespace around it. */
function skipOptional(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i] as string)) i += 1;
  if (text[i] !== "[") return at;
  for (; i < text.length; i += 1) {
    if (text[i] === "]") return i + 1;
  }
  return at;
}

/**
 * A `\title{…}` argument reduced to the words a search would use.
 *
 * `\thanks` and `\footnote` go WITH their contents — they carry funding
 * acknowledgements and email addresses, which are not part of the title and
 * would wreck any comparison. Every other command becomes a space: its name is
 * markup, and its argument's braces simply fall away, so `\emph{novel}` leaves
 * `novel` where a blanket removal would lose the word.
 */
function cleanTexTitle(raw: string): string {
  let out = raw;
  for (const command of ["thanks", "footnote"]) {
    for (;;) {
      const at = out.indexOf(`\\${command}`);
      if (at === -1) break;
      const open = out.indexOf("{", at);
      const group = open === -1 ? undefined : balancedGroup(out, open);
      if (group === undefined) {
        out = `${out.slice(0, at)} ${out.slice(at + command.length + 1)}`;
        break;
      }
      out = `${out.slice(0, at)} ${out.slice(open + group.length + 2)}`;
    }
  }
  return (
    out
      .replace(/\\\\/g, " ")
      .replace(/~/g, " ")
      // TeX's escaped punctuation is the CHARACTER, not a command: `40\%` is
      // forty percent. Done BEFORE commands are stripped, so `\%` is never
      // mistaken for one and the digit does not end up orphaned.
      .replace(/\\([%&_#${}])/g, "$1")
      .replace(/\\[a-zA-Z@]+\*?/g, " ")
      .replace(/[{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** The title of one `.tex` file, or `undefined`. */
function texTitle(content: string): string | undefined {
  const text = stripComments(content);
  // `\title` and not `\subtitle` or `\titleformat`: the next character has to
  // end the command name.
  const match = /\\title\b(?![a-zA-Z@])/.exec(text);
  if (match === null) return undefined;
  const afterOptional = skipOptional(text, match.index + match[0].length);
  const open = text.indexOf("{", afterOptional);
  if (open === -1) return undefined;
  const group = balancedGroup(text, open);
  if (group === undefined) return undefined;
  const title = cleanTexTitle(group);
  return title === "" ? undefined : title;
}

/** The title of one Markdown file: YAML front matter first, then the first
 *  `# ` heading. */
function markdownTitle(content: string): string | undefined {
  const lines = content.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (line.trim() === "---") break;
      const front = /^title\s*:\s*(.*)$/i.exec(line);
      if (front === null) continue;
      // A quoted scalar is the common shape; strip one matching pair.
      const value = (front[1] ?? "")
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
      if (value !== "") return value;
    }
  }
  for (const line of lines) {
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading === null) continue;
    const value = (heading[1] ?? "").trim();
    if (value !== "") return value;
  }
  return undefined;
}

/**
 * The manuscript's title, or `undefined` when no file offers one.
 *
 * The **entry file first**, then the rest in map order: on an `\input`-split
 * paper the entry is the preamble shell that actually carries `\title`, and on
 * a single-file paper it is the only candidate anyway. A `.bib` is skipped —
 * every entry in it has a `title` field, and none of them is this paper's.
 */
export function manuscriptTitle(
  manuscript: Pick<Manuscript, "files" | "defaultFile">,
): string | undefined {
  const order = [
    manuscript.defaultFile,
    ...[...manuscript.files.keys()].filter((f) => f !== manuscript.defaultFile),
  ];
  for (const path of order) {
    const content = manuscript.files.get(path);
    if (content === undefined) continue;
    const lower = path.toLowerCase();
    if (lower.endsWith(".bib")) continue;
    const title = lower.endsWith(".md")
      ? markdownTitle(content)
      : texTitle(content);
    if (title !== undefined) return title;
  }
  return undefined;
}
