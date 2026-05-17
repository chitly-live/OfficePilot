/**
 * Predictions-scope metrics aggregation for AI insights (SPEC.md §10.3 — v0.1.3
 * "Predictions scope").
 *
 * `aggregatePredictions` snapshots a 28-day daily time series for the four
 * forecast-worthy signals (ad spend, new leads, blended CAC, weekly CAC), runs
 * a tiny ordinary-least-squares linear regression on each daily series, and
 * projects the next 7 days. The output is JSON-serialisable and can be
 * persisted verbatim in `AIInsight.rawData`.
 *
 * ## What this is NOT
 *
 * This is a deliberately NAIVE forecast: simple linear regression on the last
 * 28 daily points, no seasonality decomposition, no exponential smoothing, no
 * day-of-week effects. It is therefore suitable for answering "is the curve
 * heading up, down, or flat over the next week?" but unsuitable for
 * predicting an exact rupee amount more than a few days out. The
 * `confidence` bucket (low/medium/high) is derived from the regression's R²
 * so Claude can hedge appropriately in its narrative.
 *
 * ## Daily buckets
 *
 *   - **Daily spend** — `Campaign.spent` is a *cumulative* field (a campaign
 *     that has spent ₹10 000 over its lifetime stores `spent = 10 000`), so
 *     summing it across campaigns and grouping by day would over-count
 *     dramatically. Where possible we reconstruct daily deltas from
 *     `ActivityLog.campaign.spent_updated` events; the metadata payload for
 *     that action carries `from` and `to` numbers (see
 *     `src/lib/activity.ts`). When the event stream is empty we fall back to
 *     an approximate "spend was incurred uniformly between `startDate` and
 *     `endDate`" attribution against active campaigns. This fallback is
 *     coarse but stable for new tenants — the cron writes events going
 *     forward so the regression becomes accurate within a few days.
 *
 *   - **Daily new leads** — `prisma.lead.count` grouped by `DATE(createdAt)`.
 *     Straightforward.
 *
 *   - **Daily new signups** — sum of `campaign.metrics_updated` /
 *     `campaign.spent_updated` event deltas with a `signups`/`signupsDelta`
 *     field in metadata. We treat signups the same way as spend: prefer
 *     event-stream deltas, fall back to a uniform attribution across the
 *     campaign's active window.
 *
 *   - **Weekly CAC** — four buckets (week-1 = oldest, week-4 = newest):
 *     `weekSpend / weekSignups`, with `null`-as-0 to keep the output a
 *     fixed 4-tuple. CAC values are also fed into the CAC forecast series
 *     (one synthetic data-point per week, repeated daily, so the same
 *     regression helper can be reused).
 *
 * ## Confidence bucketing (from R²)
 *
 *   - R² <  0.3  →  `'low'`     (noisy / flat — treat as "directional only")
 *   - 0.3–0.6    →  `'medium'`  (clear trend but with scatter)
 *   - R² >  0.6  →  `'high'`    (tight linear fit; safe to quote numbers)
 *
 * ## Trend direction
 *
 * `slopePct` is the regression slope expressed as a percentage of the
 * series mean. Anything with `|slopePct| > 5` (i.e. > 5% change per day
 * relative to the mean) is flagged as `'up'` or `'down'`; everything else
 * is `'flat'`. This matches the FLAT_THRESHOLD from `@/lib/trend` so the
 * dashboard and the forecast tab use the same band.
 *
 * The function is dependency-injected: pass a `PrismaClient` or
 * `Prisma.TransactionClient`. The return value is a plain JSON-serialisable
 * object (no `Date`, no `BigInt`) suitable for storing in `AIInsight.rawData`
 * and for shipping straight to the Claude prompt.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PredictionsDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * One day's value for a time-series. `date` is the ISO date (YYYY-MM-DD) at
 * UTC midnight; `value` is the metric for that calendar day.
 */
export interface TimeSeriesPoint {
  date: string;
  value: number;
}

/**
 * Naive linear-regression forecast for a 28-day daily time series.
 *
 *   - `daily`              — 28 ordered points (oldest first).
 *   - `next7DayProjection` — sum of `y` for x in [28, 29, ..., 34].
 *   - `trendDirection`     — `'up'` / `'down'` / `'flat'` per the 5%
 *                            slope-vs-mean threshold.
 *   - `slopePct`           — slope as % of the series mean. `null` when
 *                            the mean is 0 (division undefined).
 *   - `confidence`         — `'low'` / `'medium'` / `'high'` from R².
 */
export interface TimeSeriesForecast {
  daily: TimeSeriesPoint[];
  next7DayProjection: number;
  trendDirection: 'up' | 'down' | 'flat';
  slopePct: number | null;
  confidence: 'low' | 'medium' | 'high';
}

export interface PredictionsAggregation {
  windowDays: 28;
  projectionDays: 7;
  /** Daily spend (INR). */
  spend: TimeSeriesForecast;
  /** Daily new leads (count). */
  newLeads: TimeSeriesForecast;
  /** Daily blended CAC (INR per signup). */
  cac: TimeSeriesForecast;
  /**
   * Daily D30 cohort retention. Optional — omitted entirely when the
   * underlying data is too sparse to compute (e.g. on a new tenant).
   */
  cohortRetentionD30?: TimeSeriesForecast;
  /**
   * Exactly four numbers: blended CAC for week 1 (oldest) through week 4
   * (newest). `null` weeks are coerced to `0` so consumers can rely on a
   * fixed-length array.
   */
  weeklyCac: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 28;
const PROJECTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Slope-vs-mean threshold for `'flat'`. Matches `FLAT_THRESHOLD_PCT` (=5). */
const FLAT_SLOPE_PCT = 5;

/** R² cutoffs for the confidence bucket. */
const R2_MEDIUM = 0.3;
const R2_HIGH = 0.6;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot a 28-day daily time series + 7-day naive linear projection for
 * spend, new leads, and CAC.
 *
 * @param prisma        DI'd Prisma client / transactional client.
 * @param options.now   "Current time" — the inclusive upper bound of the
 *                      28-day window. Passed in (rather than `new Date()`)
 *                      so callers (the cron, tests) control the clock and
 *                      results stay deterministic.
 */
export async function aggregatePredictions(
  prisma: PredictionsDbClient,
  options: { now: Date },
): Promise<PredictionsAggregation> {
  const { now } = options;

  // ---------- Window: trailing 28 calendar days, UTC-aligned. ----------
  // `windowEnd` is end-of-day UTC for `now`; `windowStart` is the start
  // of the 28th-most-recent day. This is fence-post: 28 days inclusive
  // means `windowStart..windowEnd` spans 28 day-boundaries.
  const dayKeys = lastNDayKeys(now, WINDOW_DAYS);
  const windowStart = parseDayKeyToStart(dayKeys[0]);
  const windowEnd = parseDayKeyToEnd(dayKeys[dayKeys.length - 1]);

  // ---------- Parallel queries. ----------
  const [
    spentEvents,
    activeCampaigns,
    dailyLeadGroups,
    convertedLeadGroups,
  ] = await Promise.all([
    // ActivityLog rows: spend deltas, plus any campaign metrics_updated
    // rows that carry signupsDelta. We over-fetch slightly and filter in
    // memory because the metadata column is JSON and Prisma can't filter
    // by nested keys without a raw query.
    prisma.activityLog.findMany({
      where: {
        entityType: 'campaign',
        action: { in: ['campaign.spent_updated', 'campaign.metrics_updated'] },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        createdAt: true,
        action: true,
        metadata: true,
      },
    }),
    // Campaigns that overlap the window — needed for the fallback uniform
    // attribution when there are no event-stream deltas.
    prisma.campaign.findMany({
      where: {
        startDate: { lte: windowEnd },
        OR: [{ endDate: { gte: windowStart } }, { endDate: null }],
      },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        spent: true,
        signups: true,
      },
    }),
    // Daily lead-creation counts. groupBy in Prisma can't group by
    // DATE(createdAt) directly, so we pull the timestamps and bucket in
    // memory. Cheap for our volumes.
    prisma.lead.findMany({
      where: { createdAt: { gte: windowStart, lte: windowEnd } },
      select: { createdAt: true },
    }),
    // Converted leads — used as the D30 retention proxy.
    prisma.lead.findMany({
      where: {
        convertedAt: { gte: windowStart, lte: windowEnd },
      },
      select: { convertedAt: true, createdAt: true },
    }),
  ]);

  // ---------- Build daily series. ----------
  const dailySpend = bucketSpendDeltas(spentEvents, dayKeys);
  const dailySignups = bucketSignupDeltas(spentEvents, dayKeys);

  // Fallback uniform attribution for tenants that don't have an event
  // stream yet — only fills *zero* days, never overrides recorded deltas,
  // so the cron can incrementally replace fallback days with real data
  // as events accumulate.
  fillSpendFallback(dailySpend, activeCampaigns, dayKeys);
  fillSignupsFallback(dailySignups, activeCampaigns, dayKeys);

  const dailyLeads = bucketLeads(dailyLeadGroups, dayKeys);

  // Daily CAC = daily spend / daily signups, with 0-as-fallback for the
  // "no signups today" case (CAC is undefined; reporting 0 is wrong but
  // running it through the regression as 0 keeps the series length
  // stable; the consumer should treat low-confidence forecasts as
  // directional). When *both* are 0 we leave it as 0.
  const dailyCac: TimeSeriesPoint[] = dayKeys.map((dk, i) => {
    const spend = dailySpend[i].value;
    const signups = dailySignups[i].value;
    return {
      date: dk,
      value: signups > 0 ? spend / signups : 0,
    };
  });

  // ---------- Weekly CAC (oldest first). ----------
  const weeklyCac = computeWeeklyCac(dailySpend, dailySignups);

  // ---------- D30 retention (optional / sparse). ----------
  // Proxy: of leads created in the window, what fraction converted
  // within 30 days. We only emit this series when at least 7 days have
  // ≥1 created lead — otherwise the regression would be meaningless.
  const cohortRetentionD30 = maybeBuildD30Retention(
    convertedLeadGroups,
    dailyLeadGroups,
    dayKeys,
  );

  // ---------- Forecasts. ----------
  const spend = toForecast(dailySpend);
  const newLeads = toForecast(dailyLeads);
  const cac = toForecast(dailyCac);

  const out: PredictionsAggregation = {
    windowDays: WINDOW_DAYS,
    projectionDays: PROJECTION_DAYS,
    spend,
    newLeads,
    cac,
    weeklyCac,
  };
  if (cohortRetentionD30 !== null) {
    out.cohortRetentionD30 = cohortRetentionD30;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers (pure unless noted)
// ---------------------------------------------------------------------------

/**
 * Return the YYYY-MM-DD keys for the last `n` days (UTC), oldest first.
 * `now` is included as the final element.
 */
function lastNDayKeys(now: Date, n: number): string[] {
  // Snap `now` to UTC midnight; subtract (n-1) days from there.
  const todayUtcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(todayUtcMidnight.getTime() - i * MS_PER_DAY);
    out.push(toDayKey(d));
  }
  return out;
}

function toDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDayKeyToStart(key: string): Date {
  // `${YYYY-MM-DD}T00:00:00.000Z`
  return new Date(`${key}T00:00:00.000Z`);
}

function parseDayKeyToEnd(key: string): Date {
  return new Date(`${key}T23:59:59.999Z`);
}

/**
 * Zero-init a TimeSeriesPoint[] aligned to `dayKeys`. Mutated in place by
 * the bucket / fallback helpers.
 */
function zeroSeries(dayKeys: readonly string[]): TimeSeriesPoint[] {
  return dayKeys.map((date) => ({ date, value: 0 }));
}

/**
 * Bucket spend deltas from ActivityLog metadata into daily values.
 * Looks for `metadata.to` and `metadata.from` (the canonical shape for
 * `campaign.spent_updated`) — delta = to - from. Missing/invalid entries
 * are skipped silently so a corrupt audit row never tanks the forecast.
 */
function bucketSpendDeltas(
  events: readonly { createdAt: Date; action: string; metadata: unknown }[],
  dayKeys: readonly string[],
): TimeSeriesPoint[] {
  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));
  const series = zeroSeries(dayKeys);

  for (const ev of events) {
    if (ev.action !== 'campaign.spent_updated') continue;
    const meta = ev.metadata as { from?: unknown; to?: unknown } | null;
    if (meta == null || typeof meta !== 'object') continue;
    const from = numericOrNull(meta.from);
    const to = numericOrNull(meta.to);
    if (from === null || to === null) continue;
    const delta = to - from;
    // Negative deltas (corrections) are still real budget movements;
    // include them so a refund shows up.
    const key = toDayKey(ev.createdAt);
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;
    series[idx].value += delta;
  }

  return series;
}

/**
 * Bucket signup deltas from ActivityLog metadata. Looks at either
 * `campaign.metrics_updated` (preferred — carries `signupsDelta` directly)
 * or `campaign.spent_updated` (older shape — derives delta from
 * `from`/`to` on a `signups` field if present).
 */
function bucketSignupDeltas(
  events: readonly { createdAt: Date; action: string; metadata: unknown }[],
  dayKeys: readonly string[],
): TimeSeriesPoint[] {
  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));
  const series = zeroSeries(dayKeys);

  for (const ev of events) {
    const meta = ev.metadata as
      | { signupsDelta?: unknown; signupsFrom?: unknown; signupsTo?: unknown }
      | null;
    if (meta == null || typeof meta !== 'object') continue;

    let delta: number | null = numericOrNull(meta.signupsDelta);
    if (delta === null) {
      const from = numericOrNull(meta.signupsFrom);
      const to = numericOrNull(meta.signupsTo);
      if (from !== null && to !== null) delta = to - from;
    }
    if (delta === null) continue;

    const key = toDayKey(ev.createdAt);
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;
    series[idx].value += delta;
  }

  return series;
}

/**
 * Fallback uniform attribution when the event stream has nothing on a
 * given day: spread `campaign.spent` evenly across the days the campaign
 * is active inside the window. Only fills days whose current value is
 * exactly 0; never clobbers a recorded delta.
 */
function fillSpendFallback(
  series: TimeSeriesPoint[],
  campaigns: readonly {
    startDate: Date;
    endDate: Date | null;
    spent: number;
  }[],
  dayKeys: readonly string[],
): void {
  if (!seriesIsAllZero(series)) {
    // Event stream had data — trust it, even if there are zero-days
    // mixed in. We only kick in the fallback for tenants with NO
    // recorded events whatsoever.
    return;
  }
  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));

  const windowStart = parseDayKeyToStart(dayKeys[0]);
  const windowEnd = parseDayKeyToEnd(dayKeys[dayKeys.length - 1]);

  for (const c of campaigns) {
    if (c.spent <= 0) continue;
    const effectiveStart = c.startDate < windowStart ? windowStart : c.startDate;
    const effectiveEndRaw = c.endDate ?? windowEnd;
    const effectiveEnd = effectiveEndRaw > windowEnd ? windowEnd : effectiveEndRaw;
    if (effectiveEnd < effectiveStart) continue;

    // How many days of overlap are there? Count inclusive day boundaries.
    const startKey = toDayKey(effectiveStart);
    const endKey = toDayKey(effectiveEnd);
    const startIdx = indexByKey.get(startKey);
    const endIdx = indexByKey.get(endKey);
    if (startIdx === undefined || endIdx === undefined) continue;
    const days = endIdx - startIdx + 1;
    if (days <= 0) continue;

    // Spread the *whole* campaign spend across its window overlap. We
    // don't know what fraction of `spent` actually happened in the
    // 28-day window vs. before it, so this is intentionally rough.
    const perDay = c.spent / days;
    for (let i = startIdx; i <= endIdx; i += 1) {
      series[i].value += perDay;
    }
  }
}

function fillSignupsFallback(
  series: TimeSeriesPoint[],
  campaigns: readonly {
    startDate: Date;
    endDate: Date | null;
    signups: number;
  }[],
  dayKeys: readonly string[],
): void {
  if (!seriesIsAllZero(series)) return;

  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));

  const windowStart = parseDayKeyToStart(dayKeys[0]);
  const windowEnd = parseDayKeyToEnd(dayKeys[dayKeys.length - 1]);

  for (const c of campaigns) {
    if (c.signups <= 0) continue;
    const effectiveStart = c.startDate < windowStart ? windowStart : c.startDate;
    const effectiveEndRaw = c.endDate ?? windowEnd;
    const effectiveEnd = effectiveEndRaw > windowEnd ? windowEnd : effectiveEndRaw;
    if (effectiveEnd < effectiveStart) continue;

    const startIdx = indexByKey.get(toDayKey(effectiveStart));
    const endIdx = indexByKey.get(toDayKey(effectiveEnd));
    if (startIdx === undefined || endIdx === undefined) continue;
    const days = endIdx - startIdx + 1;
    if (days <= 0) continue;

    const perDay = c.signups / days;
    for (let i = startIdx; i <= endIdx; i += 1) {
      series[i].value += perDay;
    }
  }
}

function bucketLeads(
  leads: readonly { createdAt: Date }[],
  dayKeys: readonly string[],
): TimeSeriesPoint[] {
  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));
  const series = zeroSeries(dayKeys);
  for (const l of leads) {
    const idx = indexByKey.get(toDayKey(l.createdAt));
    if (idx === undefined) continue;
    series[idx].value += 1;
  }
  return series;
}

/**
 * Build the four weekly CAC buckets (oldest first). Each week is 7 days;
 * with a 28-day window this is exactly four buckets aligned to the day
 * keys. CAC = weekSpend / weekSignups, with `null` coerced to `0` so the
 * output array is a fixed length the consumers can index by `[0..3]`.
 */
function computeWeeklyCac(
  dailySpend: readonly TimeSeriesPoint[],
  dailySignups: readonly TimeSeriesPoint[],
): number[] {
  const out: number[] = [];
  for (let w = 0; w < 4; w += 1) {
    let spend = 0;
    let signups = 0;
    for (let d = 0; d < 7; d += 1) {
      const idx = w * 7 + d;
      spend += dailySpend[idx]?.value ?? 0;
      signups += dailySignups[idx]?.value ?? 0;
    }
    out.push(signups > 0 ? spend / signups : 0);
  }
  return out;
}

/**
 * Build a 28-day D30-retention proxy if and only if the cohort window
 * has enough activity for the regression to be meaningful. Returns
 * `null` when the data is too sparse.
 *
 * Retention proxy for day `d`: of all leads created on day `d`, what
 * fraction were converted (had `convertedAt` set) within 30 days. With
 * a 28-day rolling window we don't have a clean 30-day waiting period
 * for the recent days; for those we report cumulative-to-now retention,
 * which is a *lower bound*. The Claude prompt explicitly flags this.
 */
function maybeBuildD30Retention(
  converted: readonly { convertedAt: Date | null; createdAt: Date }[],
  created: readonly { createdAt: Date }[],
  dayKeys: readonly string[],
): TimeSeriesForecast | null {
  // Sparsity guard: need ≥ 7 days with non-zero created leads.
  const indexByKey = new Map<string, number>();
  dayKeys.forEach((k, i) => indexByKey.set(k, i));

  const createdByDay = zeroSeries(dayKeys);
  for (const l of created) {
    const idx = indexByKey.get(toDayKey(l.createdAt));
    if (idx === undefined) continue;
    createdByDay[idx].value += 1;
  }
  const nonZeroDays = createdByDay.reduce(
    (acc, p) => acc + (p.value > 0 ? 1 : 0),
    0,
  );
  if (nonZeroDays < 7) return null;

  const convertedByDay = zeroSeries(dayKeys);
  for (const l of converted) {
    if (l.convertedAt == null) continue;
    const idx = indexByKey.get(toDayKey(l.createdAt));
    if (idx === undefined) continue;
    // Count this conversion against the lead's *creation* day so the
    // series is per-cohort, not per-conversion.
    convertedByDay[idx].value += 1;
  }

  const retention: TimeSeriesPoint[] = dayKeys.map((dk, i) => ({
    date: dk,
    value:
      createdByDay[i].value > 0
        ? convertedByDay[i].value / createdByDay[i].value
        : 0,
  }));
  return toForecast(retention);
}

/**
 * Run the regression on a 28-day series and produce a forecast object.
 */
function toForecast(daily: TimeSeriesPoint[]): TimeSeriesForecast {
  const values = daily.map((p) => p.value);
  const { slope, intercept, r2 } = linearRegression(values);

  // Project next 7 days. x = WINDOW_DAYS, WINDOW_DAYS+1, ..., +6.
  // The series uses x = 0..WINDOW_DAYS-1 for the past 28 points so x
  // starts at WINDOW_DAYS for "tomorrow".
  let projection = 0;
  for (let i = 0; i < PROJECTION_DAYS; i += 1) {
    const x = WINDOW_DAYS + i;
    projection += slope * x + intercept;
  }
  // Clamp negative projections to 0 — a negative projection for a
  // monotone-non-negative metric like "new leads" or "spend" is a
  // signal that the linear fit is the wrong model, not that we'll
  // owe Claude leads.
  if (projection < 0) projection = 0;

  // Slope as % of mean. Sign of slope drives the direction.
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const slopePct = mean !== 0 ? (slope / mean) * 100 : null;

  let trendDirection: TimeSeriesForecast['trendDirection'];
  if (slopePct === null || Math.abs(slopePct) < FLAT_SLOPE_PCT) {
    trendDirection = 'flat';
  } else {
    trendDirection = slopePct > 0 ? 'up' : 'down';
  }

  let confidence: TimeSeriesForecast['confidence'];
  if (r2 < R2_MEDIUM) confidence = 'low';
  else if (r2 < R2_HIGH) confidence = 'medium';
  else confidence = 'high';

  return {
    daily,
    next7DayProjection: roundTo(projection, 2),
    trendDirection,
    slopePct: slopePct === null ? null : roundTo(slopePct, 2),
    confidence,
  };
}

function seriesIsAllZero(series: readonly TimeSeriesPoint[]): boolean {
  for (const p of series) {
    if (p.value !== 0) return false;
  }
  return true;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// linearRegression — simple OLS with R²
// ---------------------------------------------------------------------------

/**
 * Ordinary least-squares linear regression on a `y` series with implicit
 * integer `x` = 0, 1, 2, ..., y.length - 1.
 *
 * Returns `slope` (`m`), `intercept` (`b`), and `r2` (coefficient of
 * determination). When the variance of `x` is zero (n < 2) the slope is
 * `0` and the intercept is the (single) `y` value. When the variance of
 * `y` is zero (all values identical) R² is `1` by convention — the line
 * `y = constant` fits the data perfectly.
 *
 * No external libs — this is ~30 lines of arithmetic and avoids pulling
 * in `simple-statistics` for one call site.
 */
export function linearRegression(
  y: readonly number[],
): { slope: number; intercept: number; r2: number } {
  const n = y.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: y[0], r2: 1 };

  // x = 0..n-1
  // sum x and sum x^2 have closed forms but the loop is just as fast
  // for n=28 and easier to audit.
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += y[i];
    sumXY += i * y[i];
    sumX2 += i * i;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;

  const denom = sumX2 - n * meanX * meanX;
  // denom is variance(x) * n. For n>=2 with x=0..n-1 it's strictly
  // positive, but guard for the theoretical zero case anyway.
  const slope = denom === 0 ? 0 : (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;

  // R² via 1 - SSE/SST. SST=0 means y is constant → fit is perfect.
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = slope * i + intercept;
    sse += (y[i] - pred) ** 2;
    sst += (y[i] - meanY) ** 2;
  }
  let r2: number;
  if (sst === 0) {
    r2 = 1;
  } else {
    r2 = 1 - sse / sst;
    if (r2 < 0) r2 = 0;
    if (r2 > 1) r2 = 1;
  }

  return { slope, intercept, r2 };
}
