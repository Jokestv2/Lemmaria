/**
 * ADR 0065 §2: the blind panel, run outside every conversation.
 *
 * **What changed and why.** R3 started a panel by sending `/review` through
 * `handleComposerSend`, so the panel was a task of the active chat session: its
 * `user_message` and `review` items went into that session's transcript, its
 * result went into that session's model context, and the Review tab's history
 * was that session's history — emptied by `Lemmaria: New Session`, restarted at
 * v1. The operator reported the symptom; the cause is that a *reading of a
 * manuscript* had been modelled as a *turn of a conversation*.
 *
 * So the panel runs here instead. It is still `runSessionTask` and still the
 * same `/review` string — `parseReviewCommand` remains the one place the
 * command's grammar is known, and the driver, the seats and the synthesis are
 * untouched — but the store it runs against is a **scratch** one
 * (`createInMemorySessionStore`, the very store every `spawn_subtask` child
 * already runs on), and its events reach the Review tab rather than the
 * transcript. Nothing it emits is persisted to a session, so nothing about it
 * can be cleared by starting a new chat.
 *
 * **It takes no write path.** No `editHost`, no `snapshots` — a review never
 * writes (invariant 3, ADR 0061), and here that holds because the capability is
 * absent rather than because something refuses it.
 *
 * **It does not take the task lock.** A review and a chat can run at once
 * (§3): the review is not in the conversation, so making the conversation wait
 * for it would be a coupling with nothing behind it. `beginTask`/`endTask` are
 * the CHAT's lock and this module never touches them; it holds its own.
 */

import { randomUUID } from "node:crypto";
import {
  type NoticeItem,
  type ReviewItem,
  createInMemorySessionStore,
  runSessionTask,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import { getModel, resolvePdfReviewPanel, resolveReviewPanel } from "./model";
import { reviewPaperEntry } from "./paper-entry";
import { nextReviewVersion, presentPanelReview } from "./review-ui";
import { chargeReviewItem } from "./session/notifications";
import { workspaceRootPath } from "./session/session-state";
import { sharedTaskOptions } from "./session/task-options";
import type { ReviewRunInfo } from "./webview-protocol.js";

// `ReviewRunInfo` is defined in `webview-protocol.ts` — it crosses to the
// webview, and that file is the one home for everything that does (ADR 0011).
export type { ReviewRunInfo };

/** Listeners notified whenever the run state moves. Process-lifetime, like the
 *  review listeners next door: registered once, from activation. */
const runListeners: Array<(run: ReviewRunInfo | undefined) => void> = [];
export function onReviewRunChanged(
  listener: (run: ReviewRunInfo | undefined) => void,
): void {
  runListeners.push(listener);
}

/** The current run, or the last one that ended with nothing to show. */
let run: ReviewRunInfo | undefined;
let abort: AbortController | undefined;

function push(next: ReviewRunInfo | undefined): void {
  run = next;
  for (const l of runListeners) l(run);
}

/** The run state the tab should draw, if any. */
export function currentReviewRun(): ReviewRunInfo | undefined {
  return run;
}

/** Is a panel in flight? The Review tab's Run is disabled on this — and on
 *  nothing else, since ADR 0065 §3 detached the panel from the chat's lock. */
export function isReviewRunning(): boolean {
  return run?.running === true;
}

/** Stop the running panel (the tab's Stop). No-op when idle.
 *
 *  A stopped panel is not a lost one: the driver emits `interrupted` WITH the
 *  concerns its seats had already located (ADR 0061 §8), so the run still ends
 *  in the tab with whatever it had. */
export function stopReviewRun(): void {
  abort?.abort();
}

export type StartReviewOutcome =
  | { status: "started" }
  | { status: "busy" }
  | { status: "no-model" }
  // R9 (ADR 0069 §D8): a configured reviewer that cannot be bound. Its own
  // status rather than `no-model`, because the Writing model IS set — what is
  // missing is the model this reviewer was pointed at, and saying "add a
  // model" would send the reader to a control that is already filled in.
  | { status: "no-reviewer-model"; role: string }
  // V6's E1 round: a `/review-pdf` with the PDF reviewer switched Off would
  // seat nobody. Its own status, not `no-reviewer-model`: nothing is unbound,
  // the user turned the role off.
  | { status: "pdf-reviewer-off" };

/**
 * Run a blind panel, detached.
 *
 * `focus` is the user's own words from `/review <focus>`, forwarded verbatim
 * (invariant 6 rule 1) by re-composing the command the driver parses — this
 * function never inspects it and never translates it.
 *
 * Returns as soon as the run is under way; the panel reports itself through
 * `onReviewRunChanged` and, on completion, through the ordinary review
 * listeners `presentPanelReview` fires.
 */
export async function startReviewRun(
  context: vscode.ExtensionContext,
  focus?: string,
  /** V4 (ADR 0081 §7): a `/review-pdf` run — the compiled paper alone. */
  opts: { pdfOnly?: true } = {},
): Promise<StartReviewOutcome> {
  // Checked before the first await, the way the chat's own lock is: two
  // panels at once would spend twice and race for the version number.
  if (isReviewRunning()) return { status: "busy" };
  push({ running: true, notices: [] });
  const controller = new AbortController();
  abort = controller;

  const resolved = await getModel(context.secrets);
  if (!resolved) {
    push(undefined);
    abort = undefined;
    void vscode.window.showWarningMessage(tr(currentLocale(), "needsModel"));
    return { status: "no-model" };
  }

  // R9 (ADR 0069 §D8): who reviews, and on what — resolved BEFORE anything is
  // read or sent. A lit setting the engine silently ignores is the defect
  // ADR 0049 §1 names, and a panel that quietly ran the Writing model where
  // the Models tab shows another would be worse: the whole value of a mixed
  // panel is knowing which model said what.
  //
  // V4 (ADR 0081 §7): a `/review-pdf` run binds only the role it uses.
  const panel =
    opts.pdfOnly === true
      ? await resolvePdfReviewPanel(context.secrets)
      : await resolveReviewPanel(context.secrets);
  if ("unbound" in panel) {
    // The same teardown the no-model branch does. A run left marked running
    // would spin in the tab forever AND make every later `/review` report
    // busy — a refusal that disables the feature is not a refusal.
    push(undefined);
    abort = undefined;
    // V4: the PDF reviewer is named in the reader's language — it is a role
    // the card titles *PDF reviewer*, not an ordinal like `reviewer_a`.
    const role =
      panel.role === "pdf_reviewer"
        ? tr(currentLocale(), "rolePdfReviewer")
        : panel.role;
    void vscode.window.showWarningMessage(
      `${tr(currentLocale(), "needsReviewerModel")} (${role})`,
    );
    return { status: "no-reviewer-model", role: panel.role };
  }
  // V6's E1 round: the compiled paper alone, with nobody to read it. The run
  // went ahead and stored a version with no seat and no limit — the record
  // could not say why nothing ran, and the next panel's number moved up one.
  // Refused here, with the same teardown, and with the reason the record
  // never had; the button stays live (ADR 0062 §2's call: a dead button
  // says nothing at all).
  if (opts.pdfOnly === true && panel.pdfReviewer === "off") {
    push(undefined);
    abort = undefined;
    void vscode.window.showWarningMessage(
      tr(currentLocale(), "pdfReviewerOff"),
    );
    return { status: "pdf-reviewer-off" };
  }

  // ADR 0062 §2: the panel's entry, which is NOT the focused file. Read once,
  // here, for the same reason the composer read it once.
  const paper = await reviewPaperEntry();
  const shared = await sharedTaskOptions(context, paper, panel);
  // The verb the driver parses — `/review-pdf` for the compiled paper alone.
  const verb = opts.pdfOnly === true ? "/review-pdf" : "/review";
  const text = focus === undefined ? verb : `${verb} ${focus}`;
  const now = new Date().toISOString();

  const notices: NoticeItem[] = [];
  let item: ReviewItem | undefined;

  void (async () => {
    try {
      await runSessionTask({
        ...shared,
        // The scratch store IS the detachment: nothing this task emits is
        // appended to a session, so nothing about it survives into a chat.
        store: createInMemorySessionStore(),
        session: {
          id: randomUUID(),
          title: text,
          workspace: workspaceRootPath(),
          createdAt: now,
          updatedAt: now,
        },
        model: resolved.adapter,
        binding: resolved.binding,
        text,
        // ADR 0065 §1: the sequence is the WORKSPACE's. The scratch store's
        // transcript is empty, so leaving the harness to count it would number
        // every review v1 — which is the defect this milestone came from.
        reviewOrdinal: nextReviewVersion(),
        signal: controller.signal,
        onEvent: (event) => {
          if (
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            event.item.type === "review"
          ) {
            item = event.item;
            push({ running: true, item, notices: [...notices] });
          }
          if (event.type === "item.completed" && event.item.type === "notice") {
            notices.push(event.item);
            push({
              running: true,
              ...(item ? { item } : {}),
              notices: [...notices],
            });
          }
          // A5 + R9 (§D5): a fan-out's children never reach a turn event —
          // their usage rides the item — so charge it here, or a detached
          // panel is the one paid operation in the product that costs nothing
          // on screen. Per REVIEWER, to the model each one ran on.
          if (event.type === "item.completed" && event.item.type === "review")
            chargeReviewItem(event.item, resolved.binding.model);
        },
      });
    } catch (err) {
      // `runSessionTask` does not throw on model failure, but the surrounding
      // I/O can. Say so rather than leaving the tab spinning forever.
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(
        currentLocale() === "zh"
          ? `Lemmaria：审稿出错——${message}`
          : `Lemmaria: review failed — ${message}`,
      );
    } finally {
      if (abort === controller) abort = undefined;
      finish(item, notices, paper);
    }
  })();

  return { status: "started" };
}

/**
 * Land the run.
 *
 * A panel that produced a result presents it — and the run state CLEARS,
 * because the results below are a better report of what happened than a row of
 * settled chips. A panel that produced nothing keeps its row, not running, so
 * the reader is told: this used to be the transcript card's job (`rCardFailed`
 * plus a notice item beside it), and detaching the panel would otherwise have
 * made a refusal completely silent.
 */
function finish(
  item: ReviewItem | undefined,
  notices: NoticeItem[],
  paper: { root: string; entry: string } | undefined,
): void {
  const result = item?.result;
  if (result !== undefined && paper !== undefined) {
    push(undefined);
    presentPanelReview(result, paper.root, paper.entry, {
      // ADR 0062 §1: the version and the date ride the item, so the tab's
      // picker names the review by the number the run stamped.
      ...(item?.version !== undefined ? { version: item.version } : {}),
      ...(item?.at !== undefined ? { at: item.at } : {}),
      // R9 (ADR 0069 §D8): and so do the reviewers — the tab groups by the
      // panel that actually ran, and names each reviewer's model.
      ...(item?.seats !== undefined ? { seats: item.seats } : {}),
      ...(item?.synthesisSeat !== undefined
        ? { synthesisSeat: item.synthesisSeat }
        : {}),
      // X5 (ADR 0074 §8): and the cross-review, which has ridden the item
      // since R9 and stopped here. A SIBLING of `seats`, never a fourth row
      // of it — folding it in would charge it twice, render it as a reviewer
      // that raised no concern, and make three measurements count four seats.
      // V1 (ADR 0076 §7): and the verifier, the same way and for the same
      // reasons — a sibling, charged once, never a reviewer.
      ...(item?.verifierSeat !== undefined
        ? { verifierSeat: item.verifierSeat }
        : {}),
      // V4 (ADR 0081 §3): and the PDF reviewer, the same way — plus the PDF
      // it read, and which kind of review this was.
      ...(item?.pdfSeat !== undefined ? { pdfSeat: item.pdfSeat } : {}),
      ...(item?.pdf !== undefined ? { pdf: item.pdf } : {}),
      ...(item?.pdfOnly === true ? { mode: "pdf" as const } : {}),
    });
    return;
  }
  push({ running: false, ...(item ? { item } : {}), notices: [...notices] });
}
