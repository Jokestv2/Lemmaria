/**
 * Citation checking C1 — offline consistency (M7). Turns the project's cited
 * keys + parsed .bib entries into the unified `Warning` stream (source:
 * "citation"), so missing/orphan/duplicate defects emit the same unified
 * `Warning` shape as compile warnings. Pure — no I/O, no VS Code, no model.
 *
 * Also `applyBibDiff`: apply a C2 `BibDiff` correction to raw .bib source,
 * returning new text (the host renders it as an Accept-gated diff; invariant 3).
 */

import { createHash } from "node:crypto";
import type { BibDiff, Warning } from "../contracts/data.js";
import type { SessionLocale } from "../contracts/sessions.js";

export interface CitationRecord {
  key: string;
  fields: Record<string, string>;
  /** The .bib file the entry came from (for warning attribution). */
  file: string;
  line?: number;
}

export interface CitationConsistencyInput {
  /** Every \cite-family key used in the document (may repeat). */
  citedKeys: string[];
  /** Every parsed .bib entry (may include duplicate keys). */
  entries: CitationRecord[];
  /** Fallback file for warnings not tied to a specific .bib (undefined citations). */
  entryFile: string;
}

function citationWarningId(code: string, file: string, disc: string): string {
  return createHash("sha1")
    .update(`${code} ${file} ${disc}`)
    .digest("hex")
    .slice(0, 16);
}

function normDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

/** A cross-key equality signature: DOI if present, else normalized title+year. */
function entrySignature(fields: Record<string, string>): string | undefined {
  if (fields.doi) return `doi:${normDoi(fields.doi)}`;
  if (fields.title) {
    const t = fields.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t) return `title:${t}:${(fields.year ?? "").trim()}`;
  }
  return undefined;
}

/**
 * The four consistency warnings, in the reader's language (invariant 6 rule 2,
 * ADR 0034). Before D4 each was one `"English. 中文。"` string.
 */
const MESSAGES = {
  en: {
    undefinedCitation: (key: string) =>
      `Citation key "${key}" is not defined in any .bib file.`,
    orphanCitation: (key: string) => `Bib entry "${key}" is never cited.`,
    duplicateKey: (key: string, n: number) =>
      `Citation key "${key}" is defined ${n} times.`,
    duplicateEntry: (a: string, b: string) =>
      `Entries "${a}" and "${b}" appear to be the same reference.`,
  },
  zh: {
    undefinedCitation: (key: string) =>
      `引用键 “${key}” 未在任何 .bib 文件中定义。`,
    orphanCitation: (key: string) => `文献条目 “${key}” 从未被引用。`,
    duplicateKey: (key: string, n: number) =>
      `引用键 “${key}” 被定义了 ${n} 次。`,
    duplicateEntry: (a: string, b: string) =>
      `条目 “${a}” 与 “${b}” 疑似同一文献。`,
  },
} as const satisfies Record<SessionLocale, unknown>;

export function checkCitationConsistency(
  input: CitationConsistencyInput,
  /** D4 (ADR 0034): the language the warnings render in. */
  locale: SessionLocale = "en",
): Warning[] {
  const t = MESSAGES[locale];
  const { citedKeys, entries, entryFile } = input;
  const warnings: Warning[] = [];
  const defined = new Set(entries.map((e) => e.key));
  const cited = new Set(citedKeys);

  // undefined-citation: cited but not defined in any .bib (suspected typo / hallucination)
  const flaggedUndefined = new Set<string>();
  for (const key of citedKeys) {
    if (!defined.has(key) && !flaggedUndefined.has(key)) {
      flaggedUndefined.add(key);
      warnings.push({
        id: citationWarningId("undefined-citation", entryFile, key),
        source: "citation",
        severity: "error",
        code: "undefined-citation",
        message: t.undefinedCitation(key),
        file: entryFile,
      });
    }
  }

  // orphan-citation: defined but never cited (first occurrence per key)
  const seenKey = new Set<string>();
  for (const e of entries) {
    if (!cited.has(e.key) && !seenKey.has(e.key)) {
      warnings.push({
        id: citationWarningId("orphan-citation", e.file, e.key),
        source: "citation",
        severity: "info",
        code: "orphan-citation",
        message: t.orphanCitation(e.key),
        file: e.file,
        ...(e.line !== undefined ? { line: e.line } : {}),
      });
    }
    seenKey.add(e.key);
  }

  // duplicate-key: the same key defined by ≥2 entries
  const byKey = new Map<string, CitationRecord[]>();
  for (const e of entries) {
    const list = byKey.get(e.key);
    if (list) list.push(e);
    else byKey.set(e.key, [e]);
  }
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      const dup = list[list.length - 1] as CitationRecord;
      warnings.push({
        id: citationWarningId("duplicate-key", dup.file, key),
        source: "citation",
        severity: "error",
        code: "duplicate-key",
        message: t.duplicateKey(key, list.length),
        file: dup.file,
        ...(dup.line !== undefined ? { line: dup.line } : {}),
      });
    }
  }

  // duplicate-entry: distinct keys, same reference (shared DOI / title+year)
  const bySig = new Map<string, CitationRecord>();
  for (const e of entries) {
    const sig = entrySignature(e.fields);
    if (!sig) continue;
    const prior = bySig.get(sig);
    if (prior && prior.key !== e.key) {
      warnings.push({
        id: citationWarningId(
          "duplicate-entry",
          e.file,
          `${prior.key}|${e.key}`,
        ),
        source: "citation",
        severity: "warning",
        code: "duplicate-entry",
        message: t.duplicateEntry(prior.key, e.key),
        file: e.file,
        ...(e.line !== undefined ? { line: e.line } : {}),
      });
    } else if (!prior) {
      bySig.set(sig, e);
    }
  }

  return warnings;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locate `@type{key, … }` and return its head (through the key comma), body, and tail. */
function locateEntry(
  src: string,
  key: string,
): { head: string; body: string; tail: string } | undefined {
  const headRe = new RegExp(`@\\w+\\s*\\{\\s*${escapeRegex(key)}\\s*,`);
  const m = headRe.exec(src);
  if (!m || m.index === undefined) return undefined;
  const bodyStart = m.index + m[0].length;
  // Scan with brace depth (the entry opened one `{`) to find its close.
  let depth = 1;
  let i = bodyStart;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  if (depth !== 0) return undefined; // unterminated entry
  const closeIndex = i - 1;
  return {
    head: src.slice(0, bodyStart),
    body: src.slice(bodyStart, closeIndex),
    tail: src.slice(closeIndex),
  };
}

/**
 * Apply a `BibDiff` to raw .bib source, returning new text (never writes). Each
 * change replaces the field's value if present, else inserts the field before
 * the entry's closing brace. Scoped to the entry named by `diff.key`; if that
 * entry is not found, the source is returned unchanged.
 */
export function applyBibDiff(bibSource: string, diff: BibDiff): string {
  const found = locateEntry(bibSource, diff.key);
  if (!found) return bibSource;
  let body = found.body;
  for (const change of diff.changes) {
    const fieldRe = new RegExp(
      `(\\b${escapeRegex(change.field)}\\s*=\\s*)(\\{[^{}]*\\}|"[^"]*"|[^,\\n}]*)`,
      "i",
    );
    if (fieldRe.test(body)) {
      body = body.replace(fieldRe, `$1{${change.to}}`);
    } else {
      body = `${body.replace(/,?\s*$/, "")},\n  ${change.field} = {${change.to}}`;
    }
  }
  return `${found.head}${body}${found.tail}`;
}
