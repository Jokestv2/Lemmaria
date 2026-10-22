/**
 * Pure cumulative-cost accrual (M9): hosts persist a CostState and fold each
 * run's usage into it (this run / today / total). A run whose model has no
 * pricing accrues tokens and bumps `unpricedRuns` — the display then shows
 * token counts or flags the partial dollar figure, never a fabricated cost
 * (ADR 0002 / ADR 0009). Dates are host-supplied `YYYY-MM-DD` strings so the
 * reducer stays pure and testable.
 */

export interface CostBucket {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Runs that carried no costUsd (unknown pricing) — usd is partial if > 0. */
  unpricedRuns: number;
}

export interface CostState {
  today: { date: string } & CostBucket;
  total: CostBucket;
}

const EMPTY_BUCKET: CostBucket = {
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  unpricedRuns: 0,
};

export function emptyCostState(date: string): CostState {
  return { today: { date, ...EMPTY_BUCKET }, total: { ...EMPTY_BUCKET } };
}

/** The user's LOCAL calendar date as `YYYY-MM-DD` — "today" must follow the
 *  wall clock, not UTC (a UTC-based date rolls the bucket at 08:00 for a
 *  UTC+8 user; review fix). */
export function localDateString(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export interface AccruableUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

function addTo(bucket: CostBucket, usage: AccruableUsage): CostBucket {
  return {
    usd: bucket.usd + (usage.costUsd ?? 0),
    inputTokens: bucket.inputTokens + usage.inputTokens,
    outputTokens: bucket.outputTokens + usage.outputTokens,
    unpricedRuns: bucket.unpricedRuns + (usage.costUsd === undefined ? 1 : 0),
  };
}

/**
 * The state as it reads on `date`: a `today` bucket stamped with another day
 * is that day's spend, so on `date` it reads as empty; `total` is not a day's
 * and is unchanged. Pure; the stored state is untouched.
 *
 * ONE rule for the two moments `today` is read. `accrueUsage` rolls the
 * bucket over when a run is recorded; a display reads the state between runs,
 * and until the X5 and X6 review rounds it read the bucket as it stood — so
 * before the first run of a day the Models tab showed yesterday's figure
 * under yesterday's date, and the status bar showed it as today's with no
 * date at all.
 */
export function costAsOf(state: CostState, date: string): CostState {
  return state.today.date === date
    ? state
    : { today: { date, ...EMPTY_BUCKET }, total: state.total };
}

/** Pure: returns a new state; a differing `date` rolls `today` over first. */
export function accrueUsage(
  state: CostState,
  usage: AccruableUsage,
  date: string,
): CostState {
  const { today } = costAsOf(state, date);
  return {
    today: { date, ...addTo(today, usage) },
    total: addTo(state.total, usage),
  };
}

/**
 * One run's parts as one bucket — a panel's reviewers, its cross-review and
 * its pre-run check are one run to the person who pressed Run, though each is
 * charged to its own model.
 *
 * Folded here rather than read off the item's summed usage, because that sum's
 * `costUsd` is a lower bound whenever any part was unpriced (ADR 0074 §8): it
 * would print as a whole cost. Counting the unpriced parts keeps the figure
 * honest the way `today` and `total` already are.
 */
export function runCost(parts: readonly AccruableUsage[]): CostBucket {
  return parts.reduce(addTo, EMPTY_BUCKET);
}

/** "$0.123" | "$0.500 (+2 unpriced)" | "3.1k tok" (nothing priced). */
export function formatCostBucket(bucket: CostBucket): string {
  if (bucket.usd === 0 && bucket.unpricedRuns > 0) {
    const tokens = bucket.inputTokens + bucket.outputTokens;
    return tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k tok`
      : `${tokens} tok`;
  }
  const dollars = `$${bucket.usd.toFixed(3)}`;
  return bucket.unpricedRuns > 0
    ? `${dollars} (+${bucket.unpricedRuns} unpriced)`
    : dollars;
}
