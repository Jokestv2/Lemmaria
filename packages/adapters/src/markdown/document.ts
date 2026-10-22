/**
 * The Markdown document model (M8): a single-file, line-based parse of the
 * things every other markdown module needs — YAML frontmatter (only the
 * `bibliography:` key is interpreted), fenced code blocks, and ATX headings.
 * Hand-rolled per ADR 0001 (no markdown parser dependency); deliberate M8
 * limits (recorded in progress.md): ATX headings only (no setext), fences are
 * ``` or ~~~ at line start, Markdown has no cross-file inclusion so a project
 * is one file.
 */

import type { FileReader } from "../latex/project.js";

export interface MarkdownFence {
  startLine: number; // 1-based, the opening ``` line
  endLine: number; // 1-based, the closing ``` line (or last line if unclosed)
  startOffset: number;
  endOffset: number; // exclusive, end of the closing line
  unclosed: boolean;
}

export interface MarkdownHeading {
  level: number; // 1–6
  title: string;
  line: number; // 1-based
  offset: number; // start of the heading line
}

export interface MarkdownFrontmatter {
  raw: string; // the block INCLUDING the --- delimiters
  endLine: number; // 1-based line of the closing ---
  bibliography: string[];
}

export class MarkdownDocument {
  private constructor(
    readonly entryFile: string,
    readonly text: string,
    readonly lines: string[],
    /** Byte offset of the start of each 1-based line. */
    private readonly lineOffsets: number[],
    readonly frontmatter: MarkdownFrontmatter | undefined,
    readonly fences: MarkdownFence[],
    readonly headings: MarkdownHeading[],
  ) {}

  static async load(
    reader: FileReader,
    entryFile: string,
  ): Promise<MarkdownDocument> {
    const text = await reader.readFile(entryFile);
    const lines = text.split("\n");
    const lineOffsets: number[] = [0];
    for (const line of lines) {
      lineOffsets.push((lineOffsets.at(-1) ?? 0) + line.length + 1);
    }

    const frontmatter = parseFrontmatter(lines, lineOffsets);
    const fences = findFences(lines, lineOffsets, frontmatter?.endLine ?? 0);
    const inFence = (line: number): boolean =>
      fences.some((f) => line >= f.startLine && line <= f.endLine);

    const headings: MarkdownHeading[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      if (lineNo <= (frontmatter?.endLine ?? 0) || inFence(lineNo)) continue;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? "");
      if (m?.[1] && m[2] !== undefined) {
        headings.push({
          level: m[1].length,
          title: m[2],
          line: lineNo,
          offset: lineOffsets[i] ?? 0,
        });
      }
    }

    return new MarkdownDocument(
      entryFile,
      text,
      lines,
      lineOffsets,
      frontmatter,
      fences,
      headings,
    );
  }

  /** Byte offset of the start of a 1-based line (clamped). */
  offsetOf(line: number): number {
    const idx = Math.min(Math.max(line - 1, 0), this.lines.length - 1);
    return this.lineOffsets[idx] ?? 0;
  }

  /** 1-based line containing a byte offset. */
  lineOf(offset: number): number {
    let line = 1;
    for (let i = 1; i < this.lineOffsets.length; i++) {
      if ((this.lineOffsets[i] ?? Number.POSITIVE_INFINITY) > offset) break;
      line = i + 1;
    }
    return line;
  }
}

function parseFrontmatter(
  lines: string[],
  lineOffsets: number[],
): MarkdownFrontmatter | undefined {
  if (lines[0]?.trim() !== "---") return undefined;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close < 0) return undefined;
  const body = lines.slice(1, close);
  const bibliography: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const m = /^bibliography:\s*(.*)$/.exec(body[i] ?? "");
    if (!m) continue;
    const scalar = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (scalar !== "") {
      bibliography.push(scalar);
    } else {
      for (let j = i + 1; j < body.length; j++) {
        const item = /^\s*-\s+(.+)$/.exec(body[j] ?? "");
        if (!item) break;
        bibliography.push((item[1] ?? "").trim().replace(/^["']|["']$/g, ""));
      }
    }
    break;
  }
  return {
    raw: lines.slice(0, close + 1).join("\n"),
    endLine: close + 1,
    bibliography,
  };
}

function findFences(
  lines: string[],
  lineOffsets: number[],
  skipUntilLine: number,
): MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  let open: { line: number; marker: string } | undefined;
  for (let i = skipUntilLine; i < lines.length; i++) {
    const m = /^(```+|~~~+)/.exec(lines[i] ?? "");
    if (!m?.[1]) continue;
    if (!open) {
      open = { line: i + 1, marker: m[1][0] ?? "`" };
    } else if ((m[1][0] ?? "") === open.marker) {
      fences.push(makeFence(open.line, i + 1, false, lines, lineOffsets));
      open = undefined;
    }
  }
  if (open) {
    fences.push(makeFence(open.line, lines.length, true, lines, lineOffsets));
  }
  return fences;
}

function makeFence(
  startLine: number,
  endLine: number,
  unclosed: boolean,
  lines: string[],
  lineOffsets: number[],
): MarkdownFence {
  return {
    startLine,
    endLine,
    startOffset: lineOffsets[startLine - 1] ?? 0,
    endOffset:
      (lineOffsets[endLine - 1] ?? 0) + (lines[endLine - 1]?.length ?? 0),
    unclosed,
  };
}
