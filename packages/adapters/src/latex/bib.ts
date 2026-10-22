/**
 * A small, dependency-free BibTeX parser — just enough for citation checking
 * (C1/C2). It extracts entry type, key, and field values; it is tolerant of a
 * .bib under active editing (a truncated entry is skipped, never thrown).
 */

export interface BibEntry {
  /** Citation key as written (case preserved). */
  key: string;
  /** Entry type, lowercased (e.g. "article", "inproceedings"). */
  type: string;
  /** Field name (lowercased) → unwrapped value. */
  fields: Record<string, string>;
  /** 1-based line of the `@type{key`. */
  line: number;
}

const SKIP_TYPES = new Set(["comment", "string", "preamble"]);

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
  return line;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseBibtex(source: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] !== "@") {
      i++;
      continue;
    }
    const at = i;
    i++; // past '@'
    let type = "";
    while (i < n && /[A-Za-z]/.test(source[i] as string)) type += source[i++];
    type = type.toLowerCase();
    while (i < n && /\s/.test(source[i] as string)) i++;
    const open = source[i];
    if (open !== "{" && open !== "(") continue; // not an entry body
    const close = open === "{" ? "}" : ")";
    i++; // past opener
    // key = up to first comma or the closing delimiter
    let key = "";
    while (i < n && source[i] !== "," && source[i] !== close)
      key += source[i++];
    key = key.trim();
    if (SKIP_TYPES.has(type) || key === "") {
      i = skipBalanced(source, at, open, close);
      continue;
    }
    const fields: Record<string, string> = {};
    while (i < n && source[i] !== close) {
      if (source[i] === "," || /\s/.test(source[i] as string)) {
        i++;
        continue;
      }
      // field name
      let name = "";
      while (i < n && /[A-Za-z0-9_+:-]/.test(source[i] as string))
        name += source[i++];
      while (i < n && /\s/.test(source[i] as string)) i++;
      if (source[i] !== "=") {
        // malformed field — bail to the end of this entry
        break;
      }
      i++; // past '='
      while (i < n && /\s/.test(source[i] as string)) i++;
      const value = readValue(source, i, close);
      fields[name.toLowerCase()] = collapse(value.text);
      i = value.next;
    }
    // advance past the entry's closing delimiter if present
    if (i < n && source[i] === close) i++;
    entries.push({ key, type, fields, line: lineAt(source, at) });
  }
  return entries;
}

/** Read one field value (brace / quote / bare); returns text and the next index. */
function readValue(
  src: string,
  start: number,
  entryClose: string,
): { text: string; next: number } {
  const n = src.length;
  let i = start;
  if (src[i] === "{") {
    let depth = 0;
    let out = "";
    for (; i < n; i++) {
      const c = src[i] as string;
      if (c === "{") {
        depth++;
        if (depth === 1) continue;
      } else if (c === "}") {
        depth--;
        if (depth === 0) return { text: out, next: i + 1 };
      }
      out += c;
    }
    return { text: out, next: n }; // unterminated — tolerate
  }
  if (src[i] === '"') {
    let out = "";
    for (i++; i < n; i++) {
      if (src[i] === '"') return { text: out, next: i + 1 };
      out += src[i];
    }
    return { text: out, next: n };
  }
  let out = "";
  for (; i < n; i++) {
    const c = src[i] as string;
    if (c === "," || c === entryClose) break;
    out += c;
  }
  return { text: out.trim(), next: i };
}

/** Index just past the balanced body that starts at `at`. */
function skipBalanced(
  src: string,
  at: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

export function resolveBibPaths(
  macroArg: string,
  _kind: "bibliography" | "addbibresource",
): string[] {
  return macroArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => (/\.[^/\\.]+$/.test(s) ? s : `${s}.bib`))
    .map((s) => s.replaceAll("\\", "/"));
}
