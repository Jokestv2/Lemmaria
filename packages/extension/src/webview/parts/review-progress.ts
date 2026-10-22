/**
 * A blind panel in flight, drawn at the top of the Review tab (ADR 0065 §3;
 * ADR 0037).
 *
 * **This was the transcript card.** R3 (ADR 0061 §9) put it in the composer's
 * transcript, because the panel was a task of the chat session — which seats
 * are reading, which have reported, whether the cross-panel reading was
 * produced. ADR 0065 §2 detached the review from the conversation, so the
 * account of it moves to the surface the review belongs to. Nothing about how
 * progress READS changed: the chips, the static pill with a turning ring
 * inside it (ADR 0062 §4), the version stamp and the verbatim focus are the
 * same, in the same order.
 *
 * What is gone with the card is what only a card needed: the wrapper, the
 * concern/limit counts, and the *Open the Review tab* button — this IS the
 * Review tab, and the counts are the findings rendered below it.
 */
import type { ReviewItem, SessionLocale } from "@lemmaria/harness";
import { el } from "./rows.js";
import { dayStamp, tr, versionLabel } from "./strings.js";

/**
 * The run as the tab sees it.
 *
 * `notices` arrive ALREADY RENDERED. The host pushes `NoticeItem`s, and
 * `main.ts` turns them into text with the same `noticeText` every other notice
 * in the product goes through — localizing a notice code twice would be two
 * places to get one string wrong.
 */
export interface ReviewRunView {
  running: boolean;
  item?: ReviewItem;
  notices: string[];
}

const SEAT_GLYPH: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  interrupted: "⊘",
};
const SEAT_COLOR: Record<string, string> = {
  running: "is-faint",
  completed: "is-ok",
  failed: "is-error",
  interrupted: "is-faint",
};

/**
 * One chip: a glyph, a label, and — while it is working — a spinner INSIDE it
 * (ADR 0062 §4).
 *
 * The running chip used to carry `lm-spin` itself, so the whole pill rotated,
 * text and all: at any moment two of the three seat names were upside down and
 * the row read as a fault rather than as progress. The chip is now static and
 * neutral for its whole life, and the only thing that moves is a small ring in
 * the position the state glyph occupies once the seat has settled — so the
 * chip does not change size or shift its neighbours when it lands.
 */
function chip(
  locale: SessionLocale,
  label: string,
  status: "running" | "completed" | "failed" | "interrupted" | "pending",
): HTMLElement {
  const running = status === "running";
  const color = running ? "is-faint" : (SEAT_COLOR[status] ?? "is-faint");
  const node = el("span", { class: `lm-review-chip ${color}` });
  node.append(
    running
      ? el(
          "span",
          {
            class: "lm-review-chip__spin lm-spin",
            // The ring is the only thing that says this seat is still working,
            // and a rotating glyph says nothing to a screen reader.
            "aria-label": tr(locale, "rCardWorking"),
          },
          "◜",
        )
      : el(
          "span",
          { class: "lm-review-chip__glyph" },
          SEAT_GLYPH[status] ?? "·",
        ),
  );
  node.append(el("span", { class: "lm-review-chip__label" }, label));
  return node;
}

/** One reviewer's chip: its name, the model it is running on, its state, and
 *  whether its report was handed back once for its shape (`retried`) — a fact
 *  the reader pays for and would otherwise only see as a slower reviewer.
 *
 *  R9 (ADR 0069 §D8): the model is ADR 0064 §4's principle held to — the chip
 *  names what runs — which under one model the Models tab already answered and
 *  under a mixed panel it did not. The id rather than a friendly label: this
 *  module has no model list, and the seat header below says it the same way. */
function seatChip(
  locale: SessionLocale,
  seat: ReviewItem["seats"][number],
  /** V4 (ADR 0081 §3): the name to print when it is not the seat's own —
   *  the PDF reviewer reads *PDF reviewer*, as its heading in the tab does. */
  name: string = seat.reviewer,
): HTMLElement {
  const retried =
    seat.retried === true ? ` · ${tr(locale, "rCardRetried")}` : "";
  // Both guards, not just `!== ""`: replay normalizes a pre-R9 row to `""`,
  // and a row that reached here without passing through replay would
  // otherwise render `· undefined`.
  const model =
    seat.model !== undefined && seat.model !== "" ? ` · ${seat.model}` : "";
  return chip(
    locale,
    `${name}${model}${retried}`,
    seat.status as "running" | "completed" | "failed" | "interrupted",
  );
}

/**
 * The progress block.
 *
 * Returns `undefined` when there is nothing to draw — a run that has started
 * but emitted no frame yet still needs a line, so that case says *starting*
 * rather than rendering an empty box the reader would read as a fault.
 */
export function reviewProgress(
  run: ReviewRunView,
  locale: SessionLocale,
  onStop: () => void,
): HTMLElement {
  const block = el("div", { class: "lm-review-progress" });
  const item = run.item;

  // ADR 0062 §1: which review this is, and when. Kept from the card, because
  // a reader who runs three panels over an afternoon needs to know which one
  // is on screen — and now it is the only place the number appears while the
  // panel is still running.
  const stamp = [
    ...(item?.version !== undefined
      ? [versionLabel(locale, item.version)]
      : []),
    ...(item?.at !== undefined ? [dayStamp(item.at)] : []),
  ];
  if (stamp.length > 0) {
    block.append(el("div", { class: "lm-review-stamp" }, stamp.join(" · ")));
  }
  if (item?.focus !== undefined && item.focus !== "") {
    // The user's own words, verbatim — never re-phrased, never translated
    // (invariant 6 rule 1).
    block.append(el("div", { class: "lm-review-focus" }, item.focus));
  }

  // V4 (ADR 0081 §7): a `/review-pdf` run has no reviewers and no
  // cross-review — its one seat is the whole of its progress.
  if (
    item !== undefined &&
    (item.seats.length > 0 || item.synthesis || item.pdfSeat !== undefined)
  ) {
    const chips = el("div", { class: "lm-review-chips" });
    for (const seat of item.seats) chips.append(seatChip(locale, seat));
    // V4 (ADR 0081 §3): the PDF reviewer's chip, after the reviewers' — it
    // runs in the same fan-out, and is a sibling of `seats`, never a member.
    if (item.pdfSeat !== undefined) {
      chips.append(
        seatChip(locale, item.pdfSeat, tr(locale, "rSeatPdfReviewer")),
      );
    }
    // V1 (ADR 0076 §9): between the seats and the cross-review, which is
    // where it runs. Only for a state it can be IN — Off and nothing-to-check
    // are not progress, and a chip for them would read as work that is coming.
    const v = item.verification;
    if (
      v === "pending" ||
      v === "running" ||
      v === "completed" ||
      v === "missing"
    ) {
      chips.append(
        chip(
          locale,
          tr(locale, "rCardVerification"),
          v === "missing" ? "failed" : v,
        ),
      );
    }
    if (item.synthesis !== undefined) {
      // `missing` is the synthesis's own failure word (ADR 0060 D7); the chip
      // shows it the way a failed seat is shown, and `pending` gets the
      // neutral dot the shared helper falls back to.
      chips.append(
        chip(
          locale,
          tr(locale, "rCardSynthesis"),
          item.synthesis === "missing"
            ? "failed"
            : (item.synthesis as "pending" | "running" | "completed"),
        ),
      );
    }
    block.append(chips);
  }

  const sub =
    run.running && item === undefined
      ? // The driver reads the whole manuscript before it starts a seat, so
        // this gap is real seconds on a large project, not a frame.
        tr(locale, "rRunStarting")
      : run.running
        ? tr(locale, "rCardRunning")
        : item?.status === "interrupted"
          ? tr(locale, "rCardInterrupted")
          : // A precondition refused the panel. WHY is a notice, rendered
            // below, so this line says only that nothing ran.
            tr(locale, "rCardFailed");
  block.append(el("div", { class: "lm-review-sub" }, sub));

  for (const n of run.notices) {
    block.append(el("div", { class: "lm-review-notice" }, n));
  }

  if (run.running) {
    const stop = el(
      "button",
      { class: "lm-review-stop" },
      tr(locale, "rStopPanel"),
    ) as HTMLButtonElement;
    // ADR 0061 §8: a stopped panel still reports what its seats had located,
    // so this is *stop and keep*, never *discard*.
    stop.addEventListener("click", onStop);
    block.append(stop);
  }
  return block;
}
