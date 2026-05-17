/**
 * Trend computation helpers — pure functions for week-over-week
 * (or any two-point) comparison used by the AI Analysis module
 * (SPEC.md §10.2 feature 3, §10.3, §10.4).
 *
 * Claude generates the *narrative* and *suggestion*; the *numeric*
 * trend is computed here so it is deterministic, cheap, and testable
 * without an LLM round-trip. The Claude system prompt explicitly tells
 * the model to respect this output: "If trend is flat (<5% change),
 * say so clearly; don't manufacture insights" (SPEC.md §10.4). That
 * is why {@link FLAT_THRESHOLD_PCT} is exported — callers, tests, and
 * the prompt builder must all agree on the threshold.
 *
 * Pure: no I/O, no Prisma, no environment reads, no `Date.now()`.
 * Deterministic for deterministic inputs (Property 6 in design.md
 * §16.1 — "Trend percentage is sign-correct").
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Direction of a week-over-week trend.
 *
 *   • `'up'`   — current period strictly higher than previous, beyond
 *                the {@link FLAT_THRESHOLD_PCT} band.
 *   • `'down'` — current period strictly lower than previous, beyond
 *                the {@link FLAT_THRESHOLD_PCT} band.
 *   • `'flat'` — change within ±{@link FLAT_THRESHOLD_PCT} % of the
 *                previous value, OR the trend is undefined (e.g. both
 *                sides zero, NaN/Infinity input).
 */
export type TrendDirection = 'up' | 'down' | 'flat';

/**
 * Result of a trend computation.
 *
 *   • `trend`    — categorical direction; never `null`. When the
 *                  percentage is undefined (zero baseline, NaN, etc.)
 *                  this falls back to `'flat'` unless a direction can
 *                  still be inferred from the sign of `current` (see
 *                  {@link computeTrend}).
 *   • `trendPct` — signed percent change, rounded to 2 decimal places.
 *                  `null` when the percentage is mathematically
 *                  undefined (previous = 0) or any input is non-finite.
 *
 * The shape is deliberately the JSON the AI prompt expects under
 * SPEC.md §10.4 keys `trend` and `trendPct`.
 */
export interface TrendResult {
  trend: TrendDirection;
  trendPct: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Threshold (in percent) below which a trend is reported as `'flat'`.
 *
 * Set to **5** to match SPEC.md §10.4: "If trend is flat (<5% change),
 * say so clearly". Exported so tests, the Claude prompt builder, and
 * UI copy share a single source of truth — changing the threshold in
 * one place updates all callers.
 *
 * The comparison is strictly less-than: a swing of exactly ±5 % counts
 * as `'up'` / `'down'`.
 */
export const FLAT_THRESHOLD_PCT = 5;

// ---------------------------------------------------------------------------
// computeTrend
// ---------------------------------------------------------------------------

/**
 * Compute a week-over-week (or any two-point) trend.
 *
 * Algorithm (matches SPEC.md §10.2.3 / §10.4):
 *
 *   1. If either input is non-finite (`NaN`, `+Infinity`, `-Infinity`),
 *      return `{ trend: 'flat', trendPct: null }`. Garbage in → no
 *      trend asserted; the caller should treat this as "insufficient
 *      data".
 *   2. If `previous === 0`:
 *        • `current === 0` → `{ trend: 'flat', trendPct: null }`. Both
 *          sides zero is "no change from a zero baseline"; reporting
 *          0 % would imply the metric exists, and reporting `up`
 *          would be wrong.
 *        • otherwise        → `{ trend: current > 0 ? 'up' : 'down',
 *                                trendPct: null }`. The percentage is
 *          mathematically undefined (division by zero), but the sign
 *          of `current` still tells us the direction unambiguously,
 *          which is more useful than `'flat'` for a fresh metric.
 *   3. Otherwise compute
 *        `pct = ((current − previous) / |previous|) * 100`
 *      using `Math.abs(previous)` so the *sign* of `pct` always
 *      matches `current − previous`. Without `Math.abs`, a negative
 *      previous would flip the sign and "up" would mean "down".
 *   4. Round `trendPct` to 2 decimal places via
 *      `Math.round(pct * 100) / 100`. Two decimals is the precision
 *      the dashboard renders and matches what we want to send to
 *      Claude — extra digits are noise that bloats the prompt.
 *   5. Classify with a ±{@link FLAT_THRESHOLD_PCT} % band:
 *        • `|trendPct| < FLAT_THRESHOLD_PCT` → `'flat'`
 *        • `trendPct > 0`                    → `'up'`
 *        • otherwise                         → `'down'`.
 *
 * Edge cases worth noting:
 *
 *   • `current = 0, previous = 100` → `{ trend: 'down', trendPct: -100 }`.
 *   • `current = 100, previous = 100` → `{ trend: 'flat', trendPct: 0 }`.
 *   • `current = 105, previous = 100` → `{ trend: 'up', trendPct: 5 }`
 *     (exactly 5 % is *not* flat; the band is strictly less-than).
 *   • `current = 104.99, previous = 100` → `{ trend: 'flat', trendPct: 4.99 }`.
 *   • `current = -50, previous = -100` → `pct = (-50 - -100) / 100 * 100 = 50`
 *     → `{ trend: 'up', trendPct: 50 }` (loss shrank — that's an `'up'`).
 *   • `current = NaN` or `previous = NaN` → `{ trend: 'flat',
 *     trendPct: null }`.
 *
 * Pure & deterministic: same inputs always produce the same output.
 *
 * @param current  metric value over the recent period (e.g. last 7 days).
 * @param previous metric value over the comparison period (e.g. the 7
 *                 days before that).
 * @returns trend direction plus the signed percent change (or `null`
 *          when undefined).
 */
export function computeTrend(current: number, previous: number): TrendResult {
  // Guard: any non-finite input means we can't assert a trend at all.
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { trend: 'flat', trendPct: null };
  }

  // Guard: zero baseline → percentage is undefined, but direction may
  // still be inferable from the sign of `current`.
  if (previous === 0) {
    if (current === 0) {
      return { trend: 'flat', trendPct: null };
    }
    return { trend: current > 0 ? 'up' : 'down', trendPct: null };
  }

  // Use |previous| so the sign of pct mirrors (current - previous).
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const trendPct = Math.round(pct * 100) / 100;

  let trend: TrendDirection;
  if (Math.abs(trendPct) < FLAT_THRESHOLD_PCT) {
    trend = 'flat';
  } else if (trendPct > 0) {
    trend = 'up';
  } else {
    trend = 'down';
  }

  return { trend, trendPct };
}

// ---------------------------------------------------------------------------
// compareSeries
// ---------------------------------------------------------------------------

/**
 * Convenience alias for {@link computeTrend}.
 *
 * Some call sites read more naturally as "compare these two series"
 * (e.g. the metrics aggregation layer in `src/lib/aggregations/*`),
 * while others read more naturally as "compute the trend" (e.g. the
 * AI prompt builder). Both names point to the **same** function — no
 * separate behaviour, no wrapping, no overhead. Pick whichever name
 * makes the call site clearer; tests on either name cover both.
 *
 * @see computeTrend
 */
export const compareSeries: (current: number, previous: number) => TrendResult =
  computeTrend;
