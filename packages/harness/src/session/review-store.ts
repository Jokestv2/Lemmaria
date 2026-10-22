/**
 * ADR 0065 §1: the workspace's review history, persisted.
 *
 * **Why this file exists at all.** Until ADR 0065 a review was a `review` item
 * inside a chat session's transcript, so the Review tab's picker was emptied by
 * `Lemmaria: New Session` and the version sequence restarted at v1 — the
 * operator's report. A review is a reading of a *manuscript*: it belongs to the
 * project, exactly as ADR 0064 §1 decided the paper's entry does, and it
 * outlives every conversation that happens to start one.
 *
 * One JSON file per workspace, in a directory the HOST chooses — the
 * extension puts it under `globalStorage` beside the sessions and the
 * snapshots (`reviewStoreDir`), never inside the paper repo, for ADR 0014's
 * reason: papers get shared and reviews are private.
 *
 * Here rather than in `packages/extension` because it is pure Node and holds
 * no VS Code concept — the same reason `SnapshotStore` and `SessionStore` live
 * beside it, and the same Phase-2 claim (invariant 1): a server-side Lemmaria
 * keeps a manuscript's review history exactly this way.
 *
 * **What is NOT here: triage state.** `pending`/`accepted`/`ignored`/`handed`
 * stay in memory, which is ADR 0062's call and is unchanged: an adoption is
 * only settled once its diff is Accepted, and a persisted `accepted` that the
 * user never accepted would be the store asserting an edit that is not in the
 * file. A restored review starts pending, which is honest and is what a resume
 * already did.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReviewPdfRecord,
  ReviewResult,
  ReviewSeatState,
} from "../contracts/index.js";

/**
 * One persisted review.
 *
 * `file` is stored outright rather than recomputed from `root` + `entry`: a
 * quick review's document is whatever the user had focused, which is not
 * always the entry, and reconstructing it by arithmetic would silently open
 * the wrong file for the one mode that has always named a real document.
 */
export interface StoredReview {
  /** V4 (ADR 0081): `"pdf"` is a `/review-pdf` run — the compiled paper
   *  reviewed alone. Versioned like a panel. */
  mode: "quick" | "panel" | "pdf";
  result: ReviewResult;
  /** Workspace root every `span.file` is relative to. */
  root: string;
  /** Workspace-relative path of the reviewed entry. */
  entry: string;
  /** Absolute path of the reviewed document. */
  file: string;
  /** When it was produced, epoch ms. */
  at: number;
  /** A panel's version; absent for a quick review, which is not numbered. */
  version?: number;
  /**
   * R9 (ADR 0069 §D4/§D8): the panel's seat rows — who reviewed, and on which
   * model. Absent for a quick review, which has no panel, and for a review
   * this store wrote before R9; the tab then shows no per-reviewer model
   * rather than inventing one. The store's `v` is deliberately NOT bumped for
   * an additive optional field: there is no backward-compatibility burden, and
   * treating every pre-R9 file as unreadable would throw away real history to
   * gain nothing.
   */
  seats?: ReviewSeatState[];
  /**
   * X5 (ADR 0074 §8): the CROSS-REVIEW's own seat row — the fourth child, in
   * the same shape as a reviewer (`reviewer: "synthesis"`).
   *
   * It has been on the live session item since R9 and was lost at the store
   * boundary, so a reloaded review could not say which model read across the
   * others, or what that reading cost. A **sibling** rather than a fourth row
   * of `seats`, deliberately: folding it in would make `chargeReviewItem`
   * charge it twice, make the tab render it as a reviewer that raised no
   * concern, and make the eval's agreement instrument count it as one.
   *
   * Additive and optional, so `v` is not bumped — same reasoning as `seats`.
   */
  synthesisSeat?: ReviewSeatState;
  /**
   * V1 (ADR 0076 §7): the VERIFIER's own seat row (`reviewer: "verifier"`),
   * a sibling for `synthesisSeat`'s three reasons — charged once, never
   * rendered as a reviewer, never counted as one. What it found is on the
   * result's annotations, so a reloaded review keeps its withdrawn fold.
   *
   * Additive and optional, so `v` is not bumped — same reasoning as `seats`.
   */
  verifierSeat?: ReviewSeatState;
  /**
   * V4 (ADR 0081): the PDF reviewer's own seat row (`reviewer:
   * "pdf_reviewer"`), a sibling for the same reasons as the two above.
   *
   * Additive and optional, so `v` is not bumped — same reasoning as `seats`.
   */
  pdfSeat?: ReviewSeatState;
  /** V4 (ADR 0081): the compiled PDF the review read, and its facts.
   *  Additive and optional, so `v` is not bumped. */
  pdf?: ReviewPdfRecord;
}

interface StoreFile {
  /** Format tag. Bumped only if the shape changes; an unreadable or unknown
   *  file is treated as empty rather than migrated — there is no
   *  backward-compatibility burden, and a review is cheap to re-run.
   *
   *  **2 since V2 (ADR 0078, D1).** `ReviewEvidence` was re-tagged as a
   *  discriminated union, which is a change to the shape of a stored
   *  annotation, so this rule fires as written: a `v: 1` file reads as empty
   *  and the tab's history starts over once. That is the rule, not a choice
   *  made here. */
  v: 2;
  reviews: StoredReview[];
}

/**
 * How many reviews a workspace keeps.
 *
 * A bound, because nothing else here has one: a manuscript reviewed through a
 * long revision accumulates entries forever, and each carries a full
 * `ReviewResult`. 50 is far past what a picker can usefully list and far past
 * one paper's revision history; the oldest fall off the front.
 *
 * **Dropping the oldest never renumbers anything.** The next version is
 * `max(version) + 1` over what is RETAINED, and the newest is never dropped,
 * so the sequence stays monotonic across a trim. (A counter in the file would
 * be a second home for the same fact.)
 */
export const MAX_STORED_REVIEWS = 50;

const FILE = "reviews.json";

export class ReviewStore {
  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, FILE);
  }

  /** Everything this workspace holds, oldest first. A missing, unreadable or
   *  unrecognised file answers `[]` — the tab opens empty, which is what a
   *  workspace that has never been reviewed should show anyway. */
  async load(): Promise<StoredReview[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.v !== 2 || !Array.isArray(parsed.reviews)) return [];
      return parsed.reviews;
    } catch {
      return [];
    }
  }

  /**
   * Replace the file with `reviews`, trimmed to the cap.
   *
   * Written to a sibling and renamed, so a window that dies mid-write leaves
   * the previous history intact rather than a half-written file the loader
   * would read as an empty workspace.
   */
  async save(reviews: readonly StoredReview[]): Promise<void> {
    const kept = reviews.slice(-MAX_STORED_REVIEWS);
    const body: StoreFile = { v: 2, reviews: [...kept] };
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, this.path);
  }
}

/**
 * The version the next panel takes: one past the highest a retained review
 * carries (ADR 0065 §1).
 *
 * Counted over the STORE rather than over a session's transcript, which is the
 * whole of the fix — `runSessionTask` still counts its own items when no
 * caller numbers the panel, and that is still right for the CLI, whose review
 * really does live in one task.
 */
export function nextPanelVersion(reviews: readonly StoredReview[]): number {
  let highest = 0;
  for (const r of reviews) {
    if (r.version !== undefined && r.version > highest) highest = r.version;
  }
  return highest + 1;
}
