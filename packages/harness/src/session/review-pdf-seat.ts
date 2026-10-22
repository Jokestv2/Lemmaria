/**
 * The PDF reviewer — the one panel seat that sees the compiled paper (V4, ADR
 * 0081 §3).
 *
 * Its brief, its name and its protocol's name live here rather than in the
 * 1,800-line driver, and so does the third harness-parsed composer verb that
 * runs it alone. **This file is inside the v0.3 stage guard's scope**
 * (`test/no-*.test.ts`): the brief is model-facing English (invariant 6 rule 3),
 * and it states numbers, which is exactly where a judging word would creep in.
 */

import type { PdfDocument } from "../contracts/adapters.js";
import {
  PANEL_DIMENSIONS,
  type PdfFacts,
  type ReviewAnnotation,
} from "../contracts/data.js";
import type { ReviewPdfRecord } from "../contracts/data.js";
import {
  type FloatPlacement,
  auxOfAnotherBuild,
  captionOnPage,
  floatPlacements,
  parseAuxLabels,
} from "../engine/float-pages.js";
import { describePdfFacts } from "../engine/pdf-facts.js";
import {
  type BriefContext,
  PANEL_SKILL,
  manuscriptFilesSentence,
} from "./review-panel.js";

/**
 * The seat's name — stamped into its concern ids (`pdf_reviewer-1`, …) and its
 * sibling row. Never an ordinal, so `assembleReview`'s distinct-names check can
 * never meet it twice.
 */
export const PDF_REVIEWER_NAME = "pdf_reviewer";

/** The bundled addendum the seat loads beside `blind-reviewer` (D10). */
export const PDF_SKILL = "pdf-reviewer";

/**
 * Whether one of the PDF reviewer's LOCATED concerns is about the argument
 * rather than the page — the concerns a panel sets aside (ADR 0083 §2, the
 * operator's call at J1's round 2).
 *
 * The rule is the addendum's rule 6 made mechanical: outside `presentation`,
 * a concern stays the seat's only when the page itself shows the problem. Its
 * evidence is already settled here — a page the seat never viewed dropped the
 * whole entry — so `evidence.kind === "page"` means a page it saw.
 */
export function isPdfArgumentConcern(annotation: ReviewAnnotation): boolean {
  return (
    annotation.dimension !== "presentation" &&
    annotation.evidence?.kind !== "page"
  );
}

/**
 * The confirmed page of the float each page-cited concern is anchored in
 * (ADR 0084), by concern id; a concern with none is absent from the map.
 *
 * The `.aux` names candidate pages (`floatPlacements`), and the first whose
 * text carries the float's caption (`captionOnPage`) — on that page and on no
 * other — is the one. Nothing is confirmed from an `.aux` that counts a
 * different number of pages than this PDF has (`auxPageCount`): it is another
 * build's. Async only because the PDF's text is: each page is read at most
 * once, and the rest of the PDF only once some candidate holds on its own
 * page. A page that will not give its text confirms nothing.
 */
export async function confirmedFloatPages(
  annotations: readonly ReviewAnnotation[],
  ctx: {
    files: ReadonlyMap<string, string>;
    entry: string;
    aux: string;
    document: Pick<PdfDocument, "pageCount" | "pageText">;
  },
): Promise<Map<string, number>> {
  const pages = new Map<string, number>();
  if (auxOfAnotherBuild(ctx.aux, ctx.document.pageCount)) return pages;
  const labels = parseAuxLabels(ctx.aux);
  const texts = new Map<number, Promise<string>>();
  const textOf = (page: number): Promise<string> => {
    let text = texts.get(page);
    if (text === undefined) {
      text = ctx.document.pageText(page).catch(() => "");
      texts.set(page, text);
    }
    return text;
  };
  const sources = {
    files: ctx.files,
    entry: ctx.entry,
    labels,
    pageCount: ctx.document.pageCount,
  };
  /** The caption stands on the placement's page and on no other: a second
   *  one (a supplement that restarts its numbering) leaves it unconfirmed. */
  const soleCaption = async (placement: FloatPlacement): Promise<boolean> => {
    if (!captionOnPage(await textOf(placement.page), placement)) return false;
    for (let page = 1; page <= ctx.document.pageCount; page++) {
      if (page === placement.page) continue;
      if (captionOnPage(await textOf(page), placement)) return false;
    }
    return true;
  };
  for (const annotation of annotations) {
    if (annotation.evidence?.kind !== "page") continue;
    for (const placement of floatPlacements(annotation.span, sources)) {
      if (await soleCaption(placement)) {
        pages.set(annotation.id, placement.page);
        break;
      }
    }
  }
  return pages;
}

/**
 * `/review-pdf [focus]` over a WHOLE message (ADR 0081 §7) — the third
 * harness-parsed composer verb, beside `/fork` and `/review`, and in their
 * grammar exactly: anchored, so prose that merely contains it stays a message;
 * the focus verbatim (invariant 6 rule 1); multi-line accepted.
 *
 * `/review pdf` is NOT this: that is `/review` with the focus *pdf*, and
 * `parseReviewCommand`'s grammar does not move (ADR 0061 §1 stands). The two
 * cannot collide — after `/review` that grammar requires whitespace or the end,
 * so `/review-pdf` is never a panel, and `/review-pdfx` is neither.
 */
export function parsePdfReviewCommand(text: string): { focus?: string } | null {
  const m = /^\s*\/review-pdf(?:\s+(\S[\s\S]*?))?\s*$/.exec(text);
  if (m === null) return null;
  const focus = m[1];
  return focus === undefined ? {} : { focus };
}

/**
 * The PDF reviewer's goal (ADR 0081 §3). English only.
 *
 * It opens with BOTH forced loads — `parseSkillInvocations` accepts several
 * tokens in one message (ADR 0050), so both bodies arrive before the seat's
 * first turn — and, like every brief, names no model (ADR 0069 §6).
 *
 * It lists all EIGHT dimensions, because this seat can cite a page; the text
 * reviewers' brief still lists seven.
 */
export function pdfReviewerBrief(
  ctx: BriefContext,
  facts: PdfFacts,
  source: Pick<ReviewPdfRecord, "source" | "path" | "stale">,
  viewsRemaining: number,
): string {
  const lines = [
    `/skill:${PANEL_SKILL} /skill:${PDF_SKILL}`,
    "",
    `You are \`${PDF_REVIEWER_NAME}\`, the one reviewer on this panel that sees the compiled paper. Follow the ${PANEL_SKILL} protocol and its PDF addendum, both of which you have just been given.`,
    "",
    "What the harness measured about the PDF — these are facts, not findings:",
    describePdfFacts(facts, source),
    "",
    `You may view at most ${viewsRemaining} pages in this review.`,
    "",
    manuscriptFilesSentence(ctx),
    "",
    ctx.wrapping,
    "",
    `Every concern's \`dimension\` must be one of: ${PANEL_DIMENSIONS.join(", ")}.`,
    'A `presentation` concern must carry a page you viewed as its evidence: `"evidence": {"page": N}`. You may cite a page as evidence under any dimension; a caption that contradicts its figure is a `claims` concern with the page as evidence.',
  ];
  if (ctx.focus !== undefined) {
    lines.push(
      "",
      "The author asked the panel to attend to the following. Read it as emphasis, not as a fence — raise anything else you find:",
      ctx.focus,
    );
  }
  lines.push("", "Your reply is exactly one JSON ledger and nothing else.");
  return lines.join("\n");
}
