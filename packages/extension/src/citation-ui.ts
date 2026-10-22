import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { loadAdapterFor } from "@lemmaria/adapters";
import type {
  CitationResult,
  CitationSource,
  EditProposal,
  Warning,
} from "@lemmaria/harness";
import {
  applyBibDiff,
  checkCitationConsistency,
  checkCitationMetadata,
  crossrefSource,
  dblpSource,
  semanticScholarSource,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { openProposalDiff } from "./diff-review";
import { currentLocale } from "./i18n";
import { VscodeWorkspace } from "./workspace";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * Citation checking UI (M7). `Lemmaria: Check Citations` runs C1 (offline
 * consistency → jump-to-source diagnostics, the unified `Warning` stream) and C2
 * (online metadata against Crossref/DBLP/Semantic Scholar), surfaces the request
 * endpoint (metadata-only egress), and offers an Accept-gated `BibDiff`
 * correction. All heavy lifting is in the harness; this is a thin adapter.
 */

/** C2 sources — swapped in ext-host tests (no network there). */
let sourcesOverride: CitationSource[] | undefined;
export function setCitationSourcesForTests(sources: CitationSource[]): void {
  sourcesOverride = sources;
}
export function clearCitationSourcesForTests(): void {
  sourcesOverride = undefined;
}
function citationSources(): CitationSource[] {
  return (
    sourcesOverride ?? [crossrefSource(), dblpSource(), semanticScholarSource()]
  );
}

export function citationEndpoints(): string[] {
  return citationSources().map((s) => s.endpoint);
}

/** C1 (offline) + bib-header state for one paper. Pure read; no diagnostics, no
 *  network — safe to run whenever the Citations tab opens (invariant 3). */
export interface CitationC1Result {
  available: boolean;
  root: string;
  entry: string;
  /** Basenames of the discovered .bib files (e.g. ["refs.bib"]). */
  bibFiles: string[];
  entryCount: number;
  citedKeyCount: number;
  /** Bib entry keys — the C2-checkable set. */
  entryKeys: string[];
  /** {key, fields} for the C2 metadata lookup. */
  entries: { key: string; fields: Record<string, string> }[];
  consistency: Warning[];
}

/** A fresh "unavailable" result — never share one instance, so a caller can't
 *  accidentally mutate a module-level constant's arrays. */
function unavailableC1(): CitationC1Result {
  return {
    available: false,
    root: "",
    entry: "",
    bibFiles: [],
    entryCount: 0,
    citedKeyCount: 0,
    entryKeys: [],
    entries: [],
    consistency: [],
  };
}

export async function computeCitationC1(
  uri: vscode.Uri,
): Promise<CitationC1Result> {
  if (!/\.(tex|md)$/i.test(uri.fsPath)) return unavailableC1();
  const { root, entry } = locate(uri);
  const workspace = new VscodeWorkspace(root, entry);
  let adapter: Awaited<ReturnType<typeof loadAdapterFor>>;
  try {
    adapter = await loadAdapterFor(workspace, entry);
  } catch {
    return unavailableC1();
  }
  const bibEntries = adapter.bibEntries();
  const citedKeys = adapter.citedKeys();
  const consistency = checkCitationConsistency(
    {
      citedKeys,
      entries: bibEntries.map((e) => ({
        key: e.key,
        fields: e.fields,
        file: e.file,
        line: e.line,
      })),
      entryFile: entry,
    },
    // The four C1 warnings render in the reader's language (D4). Threading
    // this is the whole point of the harness half of the sweep — without it,
    // a Chinese Citations tab shows English diagnostics.
    currentLocale(),
  );
  return {
    available: true,
    root,
    entry,
    bibFiles: [...new Set(bibEntries.map((e) => path.basename(e.file)))],
    entryCount: bibEntries.length,
    citedKeyCount: new Set(citedKeys).size,
    entryKeys: bibEntries.map((e) => e.key),
    entries: bibEntries.map((e) => ({ key: e.key, fields: e.fields })),
    consistency,
  };
}

export async function runCitationC2(
  entries: { key: string; fields: Record<string, string> }[],
): Promise<{ results: CitationResult[]; endpoints: string[] }> {
  const sources = citationSources();
  const endpoints = sources.map((s) => s.endpoint);
  if (entries.length === 0) return { results: [], endpoints };
  const results = await checkCitationMetadata(entries, { sources });
  return { results, endpoints };
}

/** Collect .bib files under `dir` (skips VCS/deps/artifacts), rooted at the
 *  paper's directory — works whether or not it is an open workspace folder. */
async function collectBibFiles(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectBibFiles(full, out);
    else if (e.name.toLowerCase().endsWith(".bib")) out.push(full);
  }
  return out;
}

/** Locate the .bib holding `key` by scanning the paper root for its entry. */
async function findBibFor(
  root: string,
  key: string,
): Promise<vscode.Uri | undefined> {
  for (const file of await collectBibFiles(root)) {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (new RegExp(`@\\w+\\s*\\{\\s*${escapeRegex(key)}\\s*,`).test(text)) {
      return vscode.Uri.file(file);
    }
  }
  return undefined;
}

/** Stage a BibDiff correction on its .bib as an Accept-gated diff (invariant 3).
 *  Returns the diff's virtual uri, or undefined if the key/correction resolves
 *  to no change. */
export async function adoptCitationCorrection(
  root: string,
  result: CitationResult,
): Promise<vscode.Uri | undefined> {
  if (!result.correction) return undefined;
  const bibUri = await findBibFor(root, result.key);
  if (!bibUri) return undefined;
  const doc = await vscode.workspace.openTextDocument(bibUri);
  const oldText = doc.getText();
  const newText = applyBibDiff(oldText, result.correction);
  if (newText === oldText) return undefined;
  const proposal: EditProposal = {
    file: path.relative(root, bibUri.fsPath).replaceAll("\\", "/"),
    span: { startOffset: 0, endOffset: oldText.length },
    expectedOriginal: oldText,
    replacement: newText,
    contract: "replace_selection",
  };
  return openProposalDiff({
    realUri: bibUri,
    documentText: oldText,
    proposal,
    onRetry: () => Promise.resolve(),
    actionName: { en: "Citation correction", zh: "引用修正" },
  });
}

/** Test seam: C1 + header for a uri (the Citations tab's always-on group). */
export const computeCitationC1ForTests = computeCitationC1;

function locate(uri: vscode.Uri): { root: string; entry: string } {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
  const entry = path.relative(root, uri.fsPath).replaceAll("\\", "/");
  return { root, entry };
}

function severityOf(w: Warning): vscode.DiagnosticSeverity {
  if (w.severity === "error") return vscode.DiagnosticSeverity.Error;
  if (w.severity === "info") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

export interface CitationOutcome {
  status: "checked" | "skipped";
  message?: string;
  consistency: Warning[];
  metadata: CitationResult[];
  endpoints: string[];
}

class CitationController {
  private readonly diagnostics: vscode.DiagnosticCollection;

  constructor(context: vscode.ExtensionContext) {
    this.diagnostics =
      vscode.languages.createDiagnosticCollection("lemmaria-citations");
    context.subscriptions.push(this.diagnostics);
  }

  /** Publish C1 warnings as jump-to-source diagnostics, grouped by file. */
  private publish(root: string, warnings: Warning[]): void {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const w of warnings) {
      const line = Math.max(0, (w.line ?? 1) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        `${w.code}: ${w.message}`,
        severityOf(w),
      );
      d.source = "Lemmaria";
      const list = byFile.get(w.file) ?? [];
      list.push(d);
      byFile.set(w.file, list);
    }
    for (const [file, diags] of byFile) {
      this.diagnostics.set(vscode.Uri.file(path.resolve(root, file)), diags);
    }
  }

  async check(uri: vscode.Uri): Promise<CitationOutcome> {
    if (!/\.(tex|md)$/i.test(uri.fsPath)) {
      return {
        status: "skipped",
        message: chrome("citationsNeedProseFile"),
        consistency: [],
        metadata: [],
        endpoints: citationEndpoints(),
      };
    }
    // M8: adapter picked by extension — Markdown gets C1 via its frontmatter
    // bibliography + [@key] cites, LaTeX via \bibliography + \cite.
    const c1 = await computeCitationC1(uri);
    if (!c1.available) {
      return {
        status: "skipped",
        message: chrome("citationsLoadFailed"),
        consistency: [],
        metadata: [],
        endpoints: citationEndpoints(),
      };
    }
    this.publish(c1.root, c1.consistency);
    // Surface the results: the C1 warnings live in the Problems panel, which may
    // be collapsed — reveal it so a run that finds issues isn't silent.
    if (c1.consistency.length > 0) {
      void vscode.commands.executeCommand("workbench.panel.markers.view.focus");
    }
    // C2 makes network calls (seconds); show a spinner so the wait between the
    // instant C1 diagnostics and the summary toast isn't a silent gap.
    const c2 =
      c1.entries.length > 0
        ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              cancellable: false,
              title: chrome("citationsChecking"),
            },
            () => runCitationC2(c1.entries),
          )
        : { results: [], endpoints: citationEndpoints() };
    this.report(c1.root, c1.consistency, c2.results, c2.endpoints);
    return {
      status: "checked",
      consistency: c1.consistency,
      metadata: c2.results,
      endpoints: c2.endpoints,
    };
  }

  /** Summarize + offer Accept-gated corrections (non-blocking). */
  private report(
    root: string,
    consistency: Warning[],
    metadata: CitationResult[],
    endpoints: string[],
  ): void {
    const mismatches = metadata.filter((r) => r.correction);
    const notFound = metadata.filter((r) => r.status === "not_found").length;
    const via = endpoints.join(", ");
    const summary =
      `Lemmaria: ${consistency.length} consistency issue(s), ` +
      `${notFound} not found, ${mismatches.length} correctable. ` +
      `Checked via ${via} (metadata only). / ` +
      `${consistency.length} 项一致性问题，${notFound} 项未找到，${mismatches.length} 项可修正。` +
      `已通过 ${via} 核对（仅发送元数据）。`;
    void vscode.window
      .showInformationMessage(
        summary,
        ...(mismatches.length > 0 ? [chrome("citationsApplyCorrection")] : []),
      )
      .then((choice) => {
        if (choice && mismatches[0])
          void adoptCitationCorrection(root, mismatches[0]);
      });
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerCitations(context: vscode.ExtensionContext): void {
  const controller = new CitationController(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lemmaria.checkCitations",
      (arg?: vscode.Uri): Promise<CitationOutcome> => {
        const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          return Promise.resolve({
            status: "skipped",
            message: chrome("citationsNoEditor"),
            consistency: [],
            metadata: [],
            endpoints: [],
          });
        }
        return controller.check(uri);
      },
    ),
  );
}
