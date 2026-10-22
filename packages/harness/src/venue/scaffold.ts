/**
 * The Scaffolder (New from Venue, architecture-design § Venue Engine):
 * resolve manifest → materialize starter_files → copy requirements.md →
 * seed PAPER.md from manifest constraints → baseline compile.
 *
 * Collect-then-write: every output byte (starter reads, live fetches, the
 * PAPER.md draft) is gathered BEFORE the first write, so any failure —
 * offline fetch, missing starter — leaves no partial project behind
 * (ADR 0010). The only writes go into the user-chosen EMPTY target folder;
 * an existing non-empty folder is refused.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SessionLocale } from "../contracts/sessions.js";
import {
  type CompileProjectOptions,
  compileProject,
} from "../engine/compile.js";
import { draftPaperMd } from "../engine/memory.js";
import { resolveEngine } from "../engine/verify.js";
import type { LoadedVenue } from "./library.js";
import { VenueError } from "./manifest.js";

export interface ScaffoldVenueOptions {
  venue: LoadedVenue;
  /** Created if missing; must be empty otherwise (refused, nothing written). */
  targetDir: string;
  /** Baseline compile: injectable; `false` = skip; default compileProject. */
  compile?:
    | ((opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>)
    | false;
  /** Host probe for resolveEngine; default () => true (try, let the spawn error surface). */
  engineAvailable?: (engine: string) => boolean;
  /** redistribute:false downloads; default globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Per fetched file; default 15000. */
  fetchTimeoutMs?: number;
  /** PAPER.md H1; default basename(targetDir). */
  paperTitle?: string;
  /** D4 (ADR 0034): the language every report and refusal renders in — and the
   *  language the drafted PAPER.md's placeholders are written in. */
  locale?: SessionLocale;
}

export interface ScaffoldReport {
  venueId: string;
  /** Rel paths, sorted: starters + requirements.md + PAPER.md + fetched. */
  filesWritten: string[];
  /** First .tex in starter_files. */
  entryFile?: string;
  compile: { engine: string; ok: boolean; log: string } | { skipped: string };
}

/** Fetch one fetch_files entry with a hard deadline: AbortSignal.timeout AND a
 *  racing rejecting timer (the M7 pattern — a fetch that ignores the signal
 *  still can't hang the scaffold). */
async function fetchFile(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }),
      deadline,
    ]);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await Promise.race([response.text(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function scaffoldVenue(
  opts: ScaffoldVenueOptions,
): Promise<ScaffoldReport> {
  const { venue, targetDir } = opts;
  const manifest = venue.manifest;

  // Emptiness check FIRST (before any collection cost or network egress).
  // Only a genuinely-absent path (ENOENT) is allowed through as "create it";
  // an existing FILE (ENOTDIR) or a non-empty/unreadable dir is refused with a
  // clean VenueError, never a raw fs error leaking to the CLI.
  const locale: SessionLocale = opts.locale ?? "en";
  const zh = locale === "zh";
  let existed = true;
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new VenueError(
        "target_not_empty",
        zh
          ? `目标文件夹非空：${targetDir}。`
          : `target folder is not empty: ${targetDir}.`,
      );
    }
  } catch (error) {
    if (error instanceof VenueError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      existed = false; // missing dir — created just before writing
    } else {
      throw new VenueError(
        "target_not_empty",
        zh
          ? `无法在 ${targetDir} 创建项目：${(error as Error).message}。`
          : `cannot scaffold into ${targetDir}: ${(error as Error).message}.`,
      );
    }
  }

  // ── Collect every output byte before the first write ──────────────────────
  const files = new Map<string, string>();

  for (const rel of [...manifest.starter_files, "requirements.md"]) {
    try {
      files.set(rel, await readFile(join(venue.dir, rel), "utf8"));
    } catch {
      throw new VenueError(
        "invalid_manifest",
        zh
          ? `模板 "${manifest.id}" 缺少文件 "${rel}"。`
          : `venue "${manifest.id}": file "${rel}" is missing from the template.`,
      );
    }
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.fetchTimeoutMs ?? 15_000;
  for (const { url, dest } of manifest.fetch_files ?? []) {
    try {
      files.set(dest, await fetchFile(fetchImpl, url, timeoutMs));
    } catch (error) {
      const reason = (error as Error).message;
      const src = manifest.source_url ?? url;
      throw new VenueError(
        "fetch_failed",
        zh
          ? `无法获取 ${url}（${reason}）——请从 ${src} 手动下载模板。`
          : `could not fetch ${url} (${reason}) — download the template manually from ${src}.`,
      );
    }
  }

  const pl = manifest.page_limit;
  files.set(
    "PAPER.md",
    draftPaperMd({
      title: opts.paperTitle ?? basename(targetDir),
      outline: [],
      locale,
      venue: {
        ...(pl
          ? {
              pageLimit: `${pl.value} ${pl.unit}${pl.note ? ` (${pl.note})` : ""}`,
            }
          : {}),
        ...(manifest.anonymity ? { anonymity: manifest.anonymity } : {}),
        ...(manifest.bibstyle ? { bibstyle: manifest.bibstyle } : {}),
      },
    }),
  );

  // ── Write ──────────────────────────────────────────────────────────────────
  if (!existed) await mkdir(targetDir, { recursive: true });
  for (const [rel, content] of files) {
    const dest = join(targetDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
  const filesWritten = [...files.keys()].sort();

  // ── Baseline compile ───────────────────────────────────────────────────────
  // An explicit compile this feature runs because the user asked for a
  // known-good starting build by invoking it — not a gate on an edit, so
  // ADR 0013 leaves it standing.
  const entryFile = manifest.starter_files.find((f) =>
    f.toLowerCase().endsWith(".tex"),
  );
  let compileOutcome: ScaffoldReport["compile"];
  if (opts.compile === false) {
    compileOutcome = { skipped: zh ? "已按要求跳过" : "skipped by request" };
  } else if (entryFile === undefined) {
    compileOutcome = {
      skipped: zh ? "没有 .tex 起始文件" : "no .tex starter file",
    };
  } else {
    const { engine, guidance } = resolveEngine({
      configEngine: manifest.engine,
      preferred: [],
      available: opts.engineAvailable ?? (() => true),
      locale,
    });
    if (guidance !== undefined) {
      compileOutcome = { skipped: guidance };
    } else {
      const run = opts.compile ?? compileProject;
      const { ok, log } = await run({
        root: targetDir,
        entry: entryFile,
        engine,
        workingCopies: new Map(),
      });
      compileOutcome = { engine, ok, log };
    }
  }

  return {
    venueId: manifest.id,
    filesWritten,
    ...(entryFile !== undefined ? { entryFile } : {}),
    compile: compileOutcome,
  };
}
