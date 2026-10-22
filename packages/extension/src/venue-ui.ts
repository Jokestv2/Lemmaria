/**
 * "Lemmaria: New from Venue" (M10): pick a venue from the library (bundled
 * dist/venues + the ~/.lemmaria/venues cache overlay, ADR 0010), pick an empty
 * folder, scaffold, and report the baseline compile. The command accepts
 * optional positional args (venueId, targetUri) so tests bypass the UI —
 * the retryProposal precedent.
 */

import {
  type LoadedVenue,
  type ScaffoldReport,
  VenueError,
  getVenue,
  listVenues,
  scaffoldVenue,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import { binaryExists } from "./verify-ui";
import { currentCompileImpl, isCompileOverridden } from "./workspace";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

interface VenueOutcome {
  status: "scaffolded" | "cancelled" | "error";
  message?: string;
  report?: ScaffoldReport;
}

let lastReport: ScaffoldReport | undefined;

/** Test seam: the last successful scaffold's report. */
export function getScaffoldReportForTests(): ScaffoldReport | undefined {
  return lastReport;
}

/** Venue-library resolution options (bundled dir + optional cache override) —
 *  shared with the webview Venue tab (U4). */
export function libraryOptions(context: vscode.ExtensionContext): {
  bundledDir: string;
  cacheDir?: string;
  locale: "en" | "zh";
} {
  const bundledDir = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "venues",
  ).fsPath;
  const cacheDir = vscode.workspace
    .getConfiguration("lemmaria.venues")
    .get<string>("cacheDir", "");
  return {
    bundledDir,
    ...(cacheDir !== "" ? { cacheDir } : {}),
    // Every VenueError the library surfaces renders in the reader's language
    // (D4). `listVenues` and `getVenue` both take it from here.
    locale: currentLocale(),
  };
}

async function pickVenue(
  context: vscode.ExtensionContext,
): Promise<LoadedVenue | undefined> {
  const { venues, errors } = await listVenues(libraryOptions(context));
  if (errors.length > 0) {
    void vscode.window.showWarningMessage(
      `${chrome("venueTemplatesFailedToLoad")}: ${errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
  const items = venues.map((venue) => {
    const m = venue.manifest;
    const detail = [
      m.page_limit
        ? `${m.page_limit.value} ${m.page_limit.unit}${m.page_limit.note ? ` (${m.page_limit.note})` : ""}`
        : undefined,
      m.anonymity,
      m.redistribute ? undefined : chrome("venueFetchesRestricted"),
    ]
      .filter((x) => x !== undefined)
      .join(" · ");
    return {
      label: `${m.name.en} / ${m.name.zh}`,
      description: `${m.id} · ${m.engine}`,
      detail,
      venue,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: chrome("venuePickTemplate"),
  });
  return picked?.venue;
}

async function pickTargetFolder(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: chrome("venueCreateHere"),
  });
  return picked?.[0];
}

async function reportOutcome(
  targetDir: string,
  report: ScaffoldReport,
): Promise<void> {
  const openFolder = chrome("venueOpenFolder");
  const openReqs = chrome("venueOpenRequirements");
  let message: string;
  let show = vscode.window.showInformationMessage;
  if ("skipped" in report.compile) {
    message = `${chrome("venueCreatedCompileSkipped")}: ${report.compile.skipped}`;
  } else if (report.compile.ok) {
    message = chrome("venueCreatedCompileOk");
  } else {
    message = chrome("venueCreatedCompileFailed");
    show = vscode.window.showWarningMessage;
  }
  const choice = await show(message, openFolder, openReqs);
  if (choice === openFolder) {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(targetDir),
      { forceNewWindow: false },
    );
  } else if (choice === openReqs) {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(vscode.Uri.file(targetDir), "requirements.md"),
    );
    await vscode.window.showTextDocument(doc);
  }
}

export function registerVenues(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lemmaria.newFromVenue",
      async (
        venueId?: string,
        targetUri?: vscode.Uri,
      ): Promise<VenueOutcome> => {
        try {
          const venue =
            typeof venueId === "string" && venueId !== ""
              ? await getVenue(venueId, libraryOptions(context))
              : await pickVenue(context);
          if (!venue) return { status: "cancelled" };

          const target =
            targetUri instanceof vscode.Uri
              ? targetUri
              : await pickTargetFolder();
          if (!target) return { status: "cancelled" };
          const targetDir = target.fsPath;

          const report = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: chrome("venueScaffolding"),
            },
            () =>
              scaffoldVenue({
                venue,
                targetDir,
                compile: currentCompileImpl(),
                // A test compile is fake — probing the real PATH would skip it.
                engineAvailable: isCompileOverridden()
                  ? () => true
                  : binaryExists,
                // Every report and refusal the scaffolder produces — and the
                // PAPER.md template it writes — follows the reader (D4).
                locale: currentLocale(),
              }),
          );
          lastReport = report;
          void reportOutcome(targetDir, report);
          return { status: "scaffolded", report };
        } catch (error) {
          const message =
            error instanceof VenueError
              ? error.message
              : `${chrome("venueFailed")}: ${(error as Error).message}`;
          void vscode.window.showErrorMessage(message);
          return { status: "error", message };
        }
      },
    ),
  );
}
