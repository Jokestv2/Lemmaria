/**
 * PAPER.md (CM1 project memory) parser — the M3 subset: H2 sections →
 * `{{profile.*}}` / `{{glossary}}` template variables. Headings match
 * case-insensitively; the ZH alias is accepted (architecture PAPER.md format).
 * Full CM1 (MEMORY.md, directory-level files, auto-draft) lands at M8.
 */

export interface GlossaryEntry {
  term: string;
  zh: string;
  abbrev: string;
}

export interface PaperMd {
  profile: {
    contribution: string;
    /** D4 / MEM-1 (ADR 0042): who the paper is written for. Changes how the
     *  prose actions pitch a rewrite, and is fixed for the life of a paper. */
    audience: string;
    /** D4 / MEM-1 (ADR 0042): the headline claims and results. What Expand By
     *  must not invent and Shrink By must not drop. */
    claims: string;
    outline: string;
    style: string;
    venue: string;
  };
  glossary: GlossaryEntry[];
  symbols: Array<{ symbol: string; meaning: string }>;
}

type SectionKey =
  | "contribution"
  | "audience"
  | "claims"
  | "outline"
  | "glossary"
  | "symbols"
  | "venue"
  | "style";

const SECTION_ALIASES: Record<string, SectionKey> = {
  contribution: "contribution",
  贡献: "contribution",
  audience: "audience",
  读者: "audience",
  claims: "claims",
  主张: "claims",
  outline: "outline",
  大纲: "outline",
  glossary: "glossary",
  术语: "glossary",
  symbols: "symbols",
  符号: "symbols",
  venue: "venue",
  投稿: "venue",
  style: "style",
  风格: "style",
};

/**
 * Strip HTML comments from a section body.
 *
 * The drafted template explains each section in a comment, so an UNFILLED
 * section would otherwise parse as its own instructions — and since D4 wired
 * `## Audience` and `## Claims` into three actions' prompts, that text would be
 * sent to the model as the paper's audience and claims ("the paper's claims
 * are: Lemmaria must not weaken, strengthen or invent any of them"). Found by
 * D4's code review.
 *
 * A comment is written for the person editing the file. Nothing Lemmaria reads
 * from `PAPER.md` should ever include one, which is why this is stripped for
 * EVERY section rather than only the two new ones — `## Style`'s placeholder
 * had the same defect in a one-line form before D4 grew it.
 */
function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function parsePaperMd(markdown: string): PaperMd {
  const paper: PaperMd = {
    profile: {
      contribution: "",
      audience: "",
      claims: "",
      outline: "",
      style: "",
      venue: "",
    },
    glossary: [],
    symbols: [],
  };
  let section: SectionKey | undefined;
  let body: string[] = [];
  const flush = () => {
    if (!section) return;
    const text = withoutComments(body.join("\n")).trim();
    if (section === "glossary") {
      paper.glossary = parseTable(text, 3).map(
        ([term = "", zh = "", abbrev = ""]) => ({
          term,
          zh,
          abbrev,
        }),
      );
    } else if (section === "symbols") {
      paper.symbols = parseTable(text, 2).map(
        ([symbol = "", meaning = ""]) => ({
          symbol,
          meaning,
        }),
      );
    } else {
      paper.profile[section] = text;
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      const name = (h2[1] ?? "").trim().toLowerCase();
      section = Object.hasOwn(SECTION_ALIASES, name)
        ? SECTION_ALIASES[name]
        : undefined;
      body = [];
    } else if (section) {
      body.push(line);
    }
  }
  flush();
  return paper;
}

/** Parse a markdown pipe-table body into rows of the first `width` cells, skipping header + separator. */
function parseTable(text: string, width: number): string[][] {
  const rows: string[][] = [];
  let sawHeader = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue; // separator row
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (!sawHeader) {
      sawHeader = true; // first non-separator row is the header
      continue;
    }
    rows.push(cells.slice(0, width));
  }
  return rows;
}

/** The pre-formatted `{{glossary}}` value: glossary table + symbol table. */
export function formatGlossary(paper: PaperMd): string {
  const parts: string[] = [];
  if (paper.glossary.length > 0) {
    parts.push(
      "| Term | 中文 | Abbrev |",
      ...paper.glossary.map((g) => `| ${g.term} | ${g.zh} | ${g.abbrev} |`),
    );
  }
  if (paper.symbols.length > 0) {
    parts.push(
      "| Symbol | Meaning |",
      ...paper.symbols.map((s) => `| ${s.symbol} | ${s.meaning} |`),
    );
  }
  return parts.join("\n");
}
