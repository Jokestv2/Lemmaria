/**
 * R9 (ADR 0069 §D8): who reviews, and on what.
 *
 * The Models tab's Reviewers and Cross-review cards edit exactly this — a
 * count, and one model per role — and it is stored beside the model list, in
 * `globalState`, because it is a property of the USER's setup rather than of a
 * workspace or a session. Each entry is a `StoredModel.id`, or `""` meaning
 * *same as Writing*; `""` is the default for every role, so a user who never
 * opens the tab gets N reviewers on the model they already chose. V1 (ADR 0076
 * §8) added the one role that reads `""` differently — the verifier's `""`
 * is *same as Cross-review* — and the one value only it may hold, `"off"`.
 *
 * **Why ids and not bindings.** A role that stored a model id string would
 * silently keep running a model the user deleted, and a role that stored a
 * whole binding would keep a stale endpoint and a stale key. Storing the
 * `StoredModel.id` makes `ModelStore` the one home for what a model IS
 * (invariant 7), and makes a deleted model observable: `get()` rewrites any id
 * the list no longer holds to `""`, which is the honest reading — *"this
 * reviewer follows Writing now"* — rather than a dangling pointer the resolver
 * would have to refuse on.
 *
 * **Why the clamp lives here too.** `panelReviewers` already clamps to
 * `MAX_FAN_OUT`, so the harness can never be made to run more (invariant 5).
 * Clamping again at this edge is not redundancy for its own sake: it keeps the
 * number the CARD draws equal to the number that will RUN, so a card that lost
 * its disabled state cannot show twelve rows against a panel of eight.
 *
 * It mirrors `ModelStore`'s storage discipline deliberately — an authoritative
 * in-memory copy, write-through to the Memento — for the reason recorded
 * there: `globalState` was observed to hand back a stale snapshot under
 * storage churn, and a roles read that "loses" the reviewer the user just
 * picked is the same defect one level over.
 */

import { MAX_FAN_OUT } from "@lemmaria/harness";
import type * as vscode from "vscode";
import {
  PDF_REVIEWER_OFF,
  type ReviewRolesInfo,
  VERIFIER_OFF,
} from "./webview-protocol";

/** The persisted shape. Identical to what crosses to the webview, and named
 *  there — `webview-protocol.ts` is the one home for everything that does
 *  (ADR 0011), and a second declaration here is a contract with two sources. */
export type ReviewRoles = ReviewRolesInfo;

export const REVIEW_ROLES_KEY = "lemmaria.reviewRoles.v1";

/**
 * V1 (ADR 0076 §8): the verifier's *Off*, declared with the wire it crosses
 * and re-exported for the host's callers — and, since V4 (ADR 0081 §8), the
 * PDF reviewer's, the same literal. It is honoured in those two fields only:
 * no other role can be off, so anywhere else it is an id the model list does
 * not hold.
 */
export { PDF_REVIEWER_OFF, VERIFIER_OFF };

/** D2's default, in the host's terms: three reviewers, all on Writing — and,
 *  since V1, a verifier on whatever the cross-review runs on; since V4, a PDF
 *  reviewer on Writing. */
export const DEFAULT_REVIEW_ROLES: ReviewRoles = {
  reviewers: ["", "", ""],
  synthesis: "",
  verifier: "",
  pdfReviewer: "",
};

/** Coerce anything the Memento hands back into a well-formed, clamped value.
 *  A synced-in or hand-edited value is untrusted input like any other. */
function normalize(roles: Partial<ReviewRoles> | undefined): ReviewRoles {
  const raw = Array.isArray(roles?.reviewers)
    ? roles.reviewers.filter((r): r is string => typeof r === "string")
    : [...DEFAULT_REVIEW_ROLES.reviewers];
  // 1..MAX_FAN_OUT. Zero reviewers is not a panel, and N = 1 is allowed on
  // purpose — it is a single standalone review, whose cross-review is then
  // honestly recorded as missing (D6).
  const reviewers = raw.length === 0 ? [""] : raw.slice(0, MAX_FAN_OUT);
  return {
    reviewers,
    synthesis: typeof roles?.synthesis === "string" ? roles.synthesis : "",
    // V1: a value stored before the field existed reads as the default — no
    // `.v2` key, so a 0.3.0 value migrates in place.
    verifier: typeof roles?.verifier === "string" ? roles.verifier : "",
    // V4: the same in-place migration — a 0.3.x value has no such field.
    pdfReviewer:
      typeof roles?.pdfReviewer === "string" ? roles.pdfReviewer : "",
  };
}

/** Rewrite every id the model list no longer holds to `""`. */
function prune(roles: ReviewRoles, known: ReadonlySet<string>): ReviewRoles {
  const live = (id: string): string => (id !== "" && known.has(id) ? id : "");
  return {
    reviewers: roles.reviewers.map(live),
    synthesis: live(roles.synthesis),
    // V1: *Off* is a choice, not a dangling id — for this field only.
    verifier:
      roles.verifier === VERIFIER_OFF ? VERIFIER_OFF : live(roles.verifier),
    // V4: and for the PDF reviewer's.
    pdfReviewer:
      roles.pdfReviewer === PDF_REVIEWER_OFF
        ? PDF_REVIEWER_OFF
        : live(roles.pdfReviewer),
  };
}

function same(a: ReviewRoles, b: ReviewRoles): boolean {
  return (
    a.synthesis === b.synthesis &&
    a.verifier === b.verifier &&
    a.pdfReviewer === b.pdfReviewer &&
    a.reviewers.length === b.reviewers.length &&
    a.reviewers.every((id, i) => id === b.reviewers[i])
  );
}

export class ReviewRolesStore {
  /** The authoritative in-session copy (globalState is the persisted mirror). */
  private roles: ReviewRoles;

  /**
   * @param globalState where the roles live.
   * @param knownModelIds the ids `ModelStore` currently holds. A function
   *   rather than the store itself: this module needs only the ids, and taking
   *   the whole store would couple the two for nothing.
   */
  constructor(
    private readonly globalState: vscode.Memento,
    private readonly knownModelIds: () => readonly string[],
  ) {
    this.roles = normalize(
      globalState.get<ReviewRoles>(REVIEW_ROLES_KEY, DEFAULT_REVIEW_ROLES),
    );
  }

  /** The roles, with every dangling id read as *same as Writing*. */
  get(): ReviewRoles {
    return prune(this.roles, new Set(this.knownModelIds()));
  }

  async set(roles: ReviewRoles): Promise<void> {
    this.roles = normalize(roles);
    await this.globalState.update(REVIEW_ROLES_KEY, this.roles);
  }

  /**
   * Persist the pruning `get()` already performs.
   *
   * Called on `ModelStore.onDidChange`, so a deleted model stops being pointed
   * at on disk and not only on screen. It is deliberately NOT what makes the
   * pushed state correct — `get()` is, and `computeModelsState` reads through
   * it — because two subscribers to one event have no order between them, and
   * a webview that showed a deleted model for one push would be a race nobody
   * could reproduce. That is also why this store fires no change event of its
   * own: there would be nothing for a listener to do that the pruning read has
   * not already done, and an event nobody subscribes to is a promise nobody
   * keeps.
   */
  async pruneRemovedModels(): Promise<void> {
    const pruned = this.get();
    if (same(pruned, this.roles)) return;
    await this.set(pruned);
  }
}
