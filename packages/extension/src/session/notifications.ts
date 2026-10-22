import type { Usage } from "@lemmaria/harness";

/**
 * The view-layer sinks the session host pushes into (B1 split of
 * `session-host.ts`). Kept apart from the session state itself because these
 * are the seam between the harness's event stream and the UI's own surfaces —
 * invariant 1's dependency direction (UI → harness) means the harness never
 * imports cost-ui or the composer, so this module is where the arrows meet.
 */

/**
 * A2 (ADR 0021): measured context occupancy for the composer's ring.
 * `occupied` omitted = genuinely unknown (before the first turn of a thread,
 * and right after a compaction) — the ring shows "—", never a stale number.
 */
export interface ContextUsage {
  occupied?: number;
  window: number;
}

let lastContextUsage: ContextUsage | undefined;
let notifyContextUsage: ((usage: ContextUsage) => void) | undefined;

/** Set by the view layer: pushes the context ring's measured occupancy. */
export function onContextUsage(notify: (usage: ContextUsage) => void): void {
  notifyContextUsage = notify;
}

export function pushContextUsage(usage: ContextUsage): void {
  lastContextUsage = usage;
  notifyContextUsage?.(usage);
}

/** The live measurement, or undefined when nothing has been measured yet. */
export const measuredContextUsage = (): ContextUsage | undefined =>
  lastContextUsage;

/** Test seam (A2): the last context occupancy pushed to the view. */
export const lastContextUsageForTests = measuredContextUsage;

export function clearMeasuredContextUsage(): void {
  lastContextUsage = undefined;
}

/**
 * A5: the sink that folds a session turn's usage into the host's accounting.
 * Set by the view layer to the M9 `recordUsage`; the harness never imports
 * cost-ui (invariant 1 keeps the dependency direction UI → harness, and this
 * module is the seam between them).
 */
let notifyTurnUsage: ((usage: Usage, model: string) => void) | undefined;

export function onTurnUsage(
  notify: (usage: Usage, model: string) => void,
): void {
  notifyTurnUsage = notify;
}

export function pushTurnUsage(usage: Usage, model: string): void {
  notifyTurnUsage?.(usage, model);
}

/** One part of a run charged in several, attributed to the model it ran on. */
export interface RunPart {
  usage: Usage;
  model: string;
}

/**
 * The X6 review round: the sink for ONE run charged in several parts — a
 * review panel, whose parts are one run to the person who pressed Run. Set by
 * the view layer to the M9 `recordRun`, beside `onTurnUsage`, for the same
 * invariant-1 reason. Through `pushTurnUsage` each part replaced the last as
 * *this run*, so the status bar read the pre-run check's cost after a panel.
 */
let notifyRunUsage: ((parts: readonly RunPart[]) => void) | undefined;

export function onRunUsage(notify: (parts: readonly RunPart[]) => void): void {
  notifyRunUsage = notify;
}

export function pushRunUsage(parts: readonly RunPart[]): void {
  if (parts.length > 0) notifyRunUsage?.(parts);
}

/**
 * A5 + R9 (ADR 0069 §D5): charge a completed review, per reviewer.
 *
 * The panel's children never reach a turn event — their usage rides the item
 * — so a review is charged here or it is free on screen. What R9 changed is
 * WHERE: the item used to be charged whole to the session's binding, which
 * priced a haiku reviewer at the Writing model's rate and showed one row for a
 * panel that ran on three models. Each reviewer's usage now goes to the model
 * that reviewer actually ran on, and the cross-review to its own, so the
 * Models tab's per-model rows are the honest picture U3 built them to be.
 *
 * `fallbackModel` covers the seat rows a review persisted before R9 has, whose
 * `model` replay normalizes to `""`; and a panel that recorded usage on no
 * seat at all is still charged whole, because losing the spend is worse than
 * attributing it coarsely.
 *
 * The parts go out together, as ONE run (the X6 review round): each is still
 * charged to its own model, and *this run* is all of them.
 */
export function chargeReviewItem(
  item: {
    seats?: ReadonlyArray<{ model?: string; usage?: Usage }>;
    synthesisSeat?: { model?: string; usage?: Usage };
    /** V1 (ADR 0076 §7): the verifier's row — one more child, charged to the
     *  model it ran on and never folded into `seats`. */
    verifierSeat?: { model?: string; usage?: Usage };
    /** V4 (ADR 0081 §3): the PDF reviewer's row — the same shape, and the
     *  same rule: charged once, to its own model, never folded into `seats`. */
    pdfSeat?: { model?: string; usage?: Usage };
    /** X5 (ADR 0074 §6): the pre-run check's rows. Real requests, real
     *  tokens — charged against the model each one asked, like any seat. */
    preflight?: ReadonlyArray<{ model?: string; usage?: Usage }>;
    usage?: Usage;
  },
  fallbackModel: string,
): void {
  const parts: RunPart[] = [];
  const charge = (seat: { model?: string; usage?: Usage }): void => {
    if (!seat.usage) return;
    parts.push({
      usage: seat.usage,
      model:
        seat.model !== undefined && seat.model !== ""
          ? seat.model
          : fallbackModel,
    });
  };
  for (const seat of item.seats ?? []) charge(seat);
  if (item.synthesisSeat) charge(item.synthesisSeat);
  if (item.verifierSeat) charge(item.verifierSeat);
  if (item.pdfSeat) charge(item.pdfSeat);
  for (const row of item.preflight ?? []) charge(row);
  // The fallback is for an item that itemised NOTHING, not for one with no
  // seats. A panel the pre-run check refused has `seats: []` and real
  // preflight usage; charging `item.usage` as well would bill the author
  // twice for the one thing that run actually spent.
  if (parts.length === 0 && item.usage)
    parts.push({ usage: item.usage, model: fallbackModel });
  pushRunUsage(parts);
}
