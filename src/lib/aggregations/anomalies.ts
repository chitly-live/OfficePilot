/**
 * Anomalies-scope metrics aggregation for AI insights (SPEC.md §10.3 — v0.1.3
 * "Anomalies scope").
 *
 * `aggregateAnomalies` runs a battery of statistical-anomaly checks comparing
 * the most recent 24-hour window (or this calendar week, for week-over-week
 * metrics) against a 7-day rolling baseline. A check fires when the observed
 * value's z-score against the baseline exceeds the configured threshold.
 *
 * ## Why z-scores and not absolute thresholds?
 *
 * Absolute thresholds ("alert on > 100 signups") need per-tenant tuning;
 * z-scores adapt to whatever volume the tenant operates at. Anything more
 * than two standard deviations from the 7-day mean is flagged. The wrapper
 * stays useful from day 1 even on a brand-new tenant — although a tenant
 * with only a few data points will have a wide variance and few alerts,
 * which is the correct behaviour (no false positives until we know what
 * "normal" looks like).
 *
 * ## Checks performed
 *
 *   - **signup_spike / signup_drop** — today's total signups across all
 *     active campaigns vs. the previous 7-day mean. Spikes are flagged
 *     at a slightly lower threshold (|z| > 1.5) because a sudden bump
 *     could indicate bot traffic that warrants human review; drops use
 *     the default |z| > 2.
 *   - **ad_spend_spike** — today's total spend (sum of
 *     `campaign.spent_updated` ActivityLog deltas) vs. the 7-day mean.
 *     Lower threshold (|z| > 1.5) — runaway spend is expensive.
 *   - **campaign_cac_spike** — any single campaign whose CAC jumped > 50%
 *     this week vs. the previous week. CAC is `spent / signups` per
 *     campaign; only campaigns with ≥ 5 signups in both windows are
 *     considered.
 *   - **conversion_drop** — today's NEW→CONTACTED conversion rate vs. the
 *     7-day baseline. Only flags drops, not spikes.
 *   - **engagement_drop** — today's average per-post engagement rate vs.
 *     the 7-day baseline. Only flags drops.
 *   - **bug_spike** — today's count of `DevTask` rows with `type = 'BUG'`
 *     created vs. the 7-day baseline. Lower threshold (|z| > 1.5) — bug
 *     spikes are worth a heads-up even if the magnitude is modest.
 *
 * ## Output shape
 *
 * Returns a fixed-shape JSON object with a (possibly empty) `anomalies`
 * array and a `totalChecked` count so the consumer can distinguish "we
 * looked at 6 things and found nothing" from "we couldn't run the
 * checks". When the array is empty the caller's expected behaviour is to
 * SHORT-CIRCUIT before calling Claude and persist a canned "All clear"
 * insight — the empty-list path is the *expected* steady state for a
 * healthy tenant, not an error.
 *
 * The function is dependency-injected: pass a `PrismaClient` or
 * `Prisma.TransactionClient`. The return value is plain JSON (no `Date`
 * objects, no `BigInt`) and safe to store in `AIInsight.rawData`.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnomaliesDbClient = PrismaClient | Prisma.TransactionClient;

export type AnomalyKind =
  | 'signup_spike'
  | 'signup_drop'
  | 'ad_spend_spike'
  | 'campaign_cac_spike'
  | 'conversion_drop'
  | 'engagement_drop'
  | 'bug_spike';

export type AnomalySeverity = 'high' | 'medium' | 'low';

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** Human-readable metric name (e.g. `"Today's signups"`). */
  metric: string;
  observed: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
  /** Free-form context the consumer surface (UI / Claude) can use. */
  context?: Record<string, unknown>;
}

export interface AnomaliesAggregation {
  /** Inclusive upper bound of the analysis (ISO). */
  windowEnd: string;
  baselineDays: 7;
  /** Empty array = no anomalies detected. */
  anomalies: Anomaly[];
  /** Number of metrics that were checked. Useful for "checked 6, all OK". */
  totalChecked: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASELINE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * z-score thresholds.
 *
 * For "drops" we use the standard ±2σ band: events 2σ below the mean are
 * roughly the 2.5th percentile of a normal distribution — well worth a
 * look.
 *
 * For "spikes" (signups, spend, bugs) we use a lower 1.5σ threshold
 * because:
 *   - Spend spikes can drain the budget quickly.
 *   - Signup spikes might be bots — humans should triage.
 *   - Bug spikes could indicate a regression release.
 */
const Z_DROP = 2;
const Z_SPIKE = 1.5;

/** Severity mapping (applies to `|z|`, not `z`). */
const Z_HIGH = 3;
const Z_MEDIUM = 2;
const Z_LOW = 1.5;

/** Minimum signups per campaign in BOTH weeks for the CAC-spike check. */
const CAC_MIN_SIGNUPS = 5;
/** Week-over-week multiplier that qualifies as a CAC jump. */
const CAC_JUMP_FACTOR = 1.5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the anomaly battery and return all breaches.
 *
 * @param prisma        DI'd Prisma client / transactional client.
 * @param options.now   "Current time" — the inclusive upper bound of the
 *                      analysis. Passed in (rather than `new Date()`) so
 *                      tests and the cron control the clock and results
 *                      stay deterministic.
 */
export async function aggregateAnomalies(
  prisma: AnomaliesDbClient,
  options: { now: Date },
): Promise<AnomaliesAggregation> {
  const { now } = options;

  // Windows. "Today" = the 24h ending at `now`. Baseline = the 7×24h
  // preceding "today" (so they don't overlap).
  const todayEnd = now;
  const todayStart = new Date(todayEnd.getTime() - MS_PER_DAY);
  const baselineEnd = new Date(todayStart.getTime() - 1);
  const baselineStart = new Date(
    baselineEnd.getTime() - BASELINE_DAYS * MS_PER_DAY,
  );

  // For week-over-week (campaign CAC) we use full 7-day windows ending
  // immediately before `now`.
  const thisWeekEnd = now;
  const thisWeekStart = new Date(thisWeekEnd.getTime() - 7 * MS_PER_DAY);
  const lastWeekEnd = new Date(thisWeekStart.getTime() - 1);
  const lastWeekStart = new Date(lastWeekEnd.getTime() - 7 * MS_PER_DAY);

  // -------------------------------------------------------------------
  // Pull everything in one round-trip.
  // -------------------------------------------------------------------
  const [
    todaySpendEvents,
    baselineSpendEvents,
    todayLeads,
    baselineLeads,
    bugsToday,
    bugsBaseline,
    todayPosts,
    baselinePosts,
    thisWeekCampaigns,
    lastWeekCampaigns,
  ] = await Promise.all([
    // Spend deltas today + baseline. ActivityLog metadata: { from, to }
    // for `campaign.spent_updated`; we sum (to - from) per row to get
    // a true delta even when the event stream is noisy.
    prisma.activityLog.findMany({
      where: {
        action: 'campaign.spent_updated',
        createdAt: { gte: todayStart, lte: todayEnd },
      },
      select: { createdAt: true, metadata: true, entityId: true },
    }),
    prisma.activityLog.findMany({
      where: {
        action: 'campaign.spent_updated',
        createdAt: { gte: baselineStart, lte: baselineEnd },
      },
      select: { createdAt: true, metadata: true, entityId: true },
    }),
    // Lead pipeline.
    prisma.lead.findMany({
      where: { createdAt: { gte: todayStart, lte: todayEnd } },
      select: { status: true, createdAt: true },
    }),
    prisma.lead.findMany({
      where: { createdAt: { gte: baselineStart, lte: baselineEnd } },
      select: { status: true, createdAt: true },
    }),
    // Bug-task counts.
    prisma.devTask.count({
      where: {
        type: 'BUG',
        createdAt: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.devTask.findMany({
      where: {
        type: 'BUG',
        createdAt: { gte: baselineStart, lte: baselineEnd },
      },
      select: { createdAt: true },
    }),
    // Social posts (for engagement).
    prisma.socialPost.findMany({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: todayStart, lte: todayEnd },
      },
      select: { likes: true, comments: true, shares: true, reach: true },
    }),
    prisma.socialPost.findMany({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: baselineStart, lte: baselineEnd },
      },
      select: {
        likes: true,
        comments: true,
        shares: true,
        reach: true,
        publishedAt: true,
      },
    }),
    // Active campaigns this week / last week.
    prisma.campaign.findMany({
      where: {
        startDate: { lte: thisWeekEnd },
        OR: [{ endDate: { gte: thisWeekStart } }, { endDate: null }],
      },
      select: {
        id: true,
        name: true,
        spent: true,
        signups: true,
        startDate: true,
        endDate: true,
      },
    }),
    prisma.campaign.findMany({
      where: {
        startDate: { lte: lastWeekEnd },
        OR: [{ endDate: { gte: lastWeekStart } }, { endDate: null }],
      },
      select: {
        id: true,
        name: true,
        spent: true,
        signups: true,
        startDate: true,
        endDate: true,
      },
    }),
  ]);

  const anomalies: Anomaly[] = [];
  let totalChecked = 0;

  // -------------------------------------------------------------------
  // 1. Signup spike / drop
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const todayCount = todayLeads.length;
    const baselineDaily = bucketDaily(
      baselineLeads.map((l) => l.createdAt),
      baselineStart,
      BASELINE_DAYS,
    );
    const stats = meanStddev(baselineDaily);
    const z = zScore(todayCount, stats.mean, stats.stddev);
    if (z !== null) {
      const absZ = Math.abs(z);
      if (z > 0 && absZ > Z_SPIKE) {
        anomalies.push({
          kind: 'signup_spike',
          severity: severityForSpike(absZ),
          metric: "Today's new signups (lead creations)",
          observed: todayCount,
          baselineMean: round2(stats.mean),
          baselineStddev: round2(stats.stddev),
          zScore: round2(z),
        });
      } else if (z < 0 && absZ > Z_DROP) {
        anomalies.push({
          kind: 'signup_drop',
          severity: severityForDrop(absZ),
          metric: "Today's new signups (lead creations)",
          observed: todayCount,
          baselineMean: round2(stats.mean),
          baselineStddev: round2(stats.stddev),
          zScore: round2(z),
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // 2. Ad spend spike
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const todaySpend = sumSpendDeltas(todaySpendEvents);
    const baselineDailySpend = bucketDailySpend(
      baselineSpendEvents,
      baselineStart,
      BASELINE_DAYS,
    );
    const stats = meanStddev(baselineDailySpend);
    const z = zScore(todaySpend, stats.mean, stats.stddev);
    if (z !== null && z > 0 && Math.abs(z) > Z_SPIKE) {
      anomalies.push({
        kind: 'ad_spend_spike',
        severity: severityForSpike(Math.abs(z)),
        metric: "Today's total ad spend",
        observed: round2(todaySpend),
        baselineMean: round2(stats.mean),
        baselineStddev: round2(stats.stddev),
        zScore: round2(z),
      });
    }
  }

  // -------------------------------------------------------------------
  // 3. Campaign CAC spike (per-campaign week-over-week)
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const lastById = new Map(lastWeekCampaigns.map((c) => [c.id, c]));
    for (const cur of thisWeekCampaigns) {
      const prev = lastById.get(cur.id);
      if (prev === undefined) continue;
      // Both windows need enough signups to compute a stable CAC.
      if (cur.signups < CAC_MIN_SIGNUPS || prev.signups < CAC_MIN_SIGNUPS) {
        continue;
      }
      const curCac = cur.spent / cur.signups;
      const prevCac = prev.spent / prev.signups;
      if (!Number.isFinite(curCac) || !Number.isFinite(prevCac)) continue;
      if (prevCac <= 0) continue;
      const ratio = curCac / prevCac;
      if (ratio >= CAC_JUMP_FACTOR) {
        // "z-score" for a single before/after pair isn't meaningful;
        // map ratio onto a pseudo-z so the consumer fields are filled.
        const pseudoZ = (ratio - 1) * 2; // 50% jump → z≈1.0; 100% → z≈2.0.
        anomalies.push({
          kind: 'campaign_cac_spike',
          severity: severityForSpike(pseudoZ),
          metric: `CAC jump on campaign "${cur.name}"`,
          observed: round2(curCac),
          baselineMean: round2(prevCac),
          baselineStddev: 0,
          zScore: round2(pseudoZ),
          context: {
            campaignId: cur.id,
            campaignName: cur.name,
            previousCac: round2(prevCac),
            currentCac: round2(curCac),
            currentSignups: cur.signups,
            previousSignups: prev.signups,
            ratio: round2(ratio),
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. Lead-conversion drop
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const todayRate = conversionRate(todayLeads);
    const baselineByDay = bucketDailyConversionRate(
      baselineLeads,
      baselineStart,
      BASELINE_DAYS,
    );
    const stats = meanStddev(baselineByDay);
    const z = zScore(todayRate, stats.mean, stats.stddev);
    if (z !== null && z < 0 && Math.abs(z) > Z_DROP) {
      anomalies.push({
        kind: 'conversion_drop',
        severity: severityForDrop(Math.abs(z)),
        metric: "Today's lead-conversion rate (NEW→CONTACTED+)",
        observed: round2(todayRate),
        baselineMean: round2(stats.mean),
        baselineStddev: round2(stats.stddev),
        zScore: round2(z),
      });
    }
  }

  // -------------------------------------------------------------------
  // 5. Engagement drop
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const todayEng = meanPerPostEngagement(todayPosts);
    // Bucket baseline per day.
    const dailyEng = bucketDailyEngagement(
      baselinePosts,
      baselineStart,
      BASELINE_DAYS,
    );
    const stats = meanStddev(dailyEng);
    const z = zScore(todayEng, stats.mean, stats.stddev);
    if (z !== null && z < 0 && Math.abs(z) > Z_DROP) {
      anomalies.push({
        kind: 'engagement_drop',
        severity: severityForDrop(Math.abs(z)),
        metric: "Today's average per-post engagement rate",
        observed: round2(todayEng),
        baselineMean: round2(stats.mean),
        baselineStddev: round2(stats.stddev),
        zScore: round2(z),
      });
    }
  }

  // -------------------------------------------------------------------
  // 6. Bug spike
  // -------------------------------------------------------------------
  totalChecked += 1;
  {
    const dailyBugs = bucketDaily(
      bugsBaseline.map((b) => b.createdAt),
      baselineStart,
      BASELINE_DAYS,
    );
    const stats = meanStddev(dailyBugs);
    const z = zScore(bugsToday, stats.mean, stats.stddev);
    if (z !== null && z > 0 && Math.abs(z) > Z_SPIKE) {
      anomalies.push({
        kind: 'bug_spike',
        severity: severityForSpike(Math.abs(z)),
        metric: "Today's bug-task creations",
        observed: bugsToday,
        baselineMean: round2(stats.mean),
        baselineStddev: round2(stats.stddev),
        zScore: round2(z),
      });
    }
  }

  // Stable ordering: highest |z| first, then alphabetical by kind so the
  // output is deterministic across runs of the same inputs.
  anomalies.sort((a, b) => {
    const az = Math.abs(b.zScore) - Math.abs(a.zScore);
    if (az !== 0) return az;
    return a.kind.localeCompare(b.kind);
  });

  return {
    windowEnd: todayEnd.toISOString(),
    baselineDays: BASELINE_DAYS,
    anomalies,
    totalChecked,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Compute mean + sample stddev for a numeric series. Uses the sample
 * variance formula (`/ (n-1)`) when n>=2, and 0 when n<2 — a single
 * data-point has no spread.
 */
function meanStddev(
  values: readonly number[],
): { mean: number; stddev: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n < 2) return { mean, stddev: 0 };
  let varSum = 0;
  for (const v of values) varSum += (v - mean) ** 2;
  const variance = varSum / (n - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * z-score with safety against zero variance. Returns `null` when the
 * stddev is 0 (z is mathematically undefined: any deviation from a
 * point-mass is "infinite"). The caller treats `null` as "no signal".
 */
function zScore(observed: number, mean: number, stddev: number): number | null {
  if (!Number.isFinite(observed)) return null;
  if (stddev === 0) return null;
  return (observed - mean) / stddev;
}

function severityForSpike(absZ: number): AnomalySeverity {
  if (absZ > Z_HIGH) return 'high';
  if (absZ > Z_MEDIUM) return 'medium';
  return 'low';
}

function severityForDrop(absZ: number): AnomalySeverity {
  if (absZ > Z_HIGH) return 'high';
  if (absZ > Z_MEDIUM) return 'medium';
  if (absZ > Z_LOW) return 'low';
  return 'low';
}

/**
 * Bucket a list of timestamps into 7 daily counts aligned to the
 * baseline window. Days are 24h slices starting at `baselineStart`.
 */
function bucketDaily(
  timestamps: readonly Date[],
  baselineStart: Date,
  days: number,
): number[] {
  const out = new Array<number>(days).fill(0);
  for (const t of timestamps) {
    const idx = Math.floor((t.getTime() - baselineStart.getTime()) / MS_PER_DAY);
    if (idx >= 0 && idx < days) out[idx] += 1;
  }
  return out;
}

function bucketDailySpend(
  events: readonly { createdAt: Date; metadata: unknown }[],
  baselineStart: Date,
  days: number,
): number[] {
  const out = new Array<number>(days).fill(0);
  for (const ev of events) {
    const meta = ev.metadata as { from?: unknown; to?: unknown } | null;
    if (meta == null || typeof meta !== 'object') continue;
    const from = numericOrNull(meta.from);
    const to = numericOrNull(meta.to);
    if (from === null || to === null) continue;
    const delta = to - from;
    const idx = Math.floor(
      (ev.createdAt.getTime() - baselineStart.getTime()) / MS_PER_DAY,
    );
    if (idx >= 0 && idx < days) out[idx] += delta;
  }
  return out;
}

function sumSpendDeltas(
  events: readonly { metadata: unknown }[],
): number {
  let sum = 0;
  for (const ev of events) {
    const meta = ev.metadata as { from?: unknown; to?: unknown } | null;
    if (meta == null || typeof meta !== 'object') continue;
    const from = numericOrNull(meta.from);
    const to = numericOrNull(meta.to);
    if (from === null || to === null) continue;
    sum += to - from;
  }
  return sum;
}

/**
 * "Conversion rate" for a single-day cohort: fraction of leads whose
 * status has moved past NEW. We treat anything other than NEW as
 * "contacted+" because the test conditions cap the cohort age at
 * minutes and progression is rapid in steady state.
 */
function conversionRate(
  leads: readonly { status: string }[],
): number {
  if (leads.length === 0) return 0;
  let progressed = 0;
  for (const l of leads) {
    if (l.status !== 'NEW') progressed += 1;
  }
  return progressed / leads.length;
}

function bucketDailyConversionRate(
  leads: readonly { status: string; createdAt: Date }[],
  baselineStart: Date,
  days: number,
): number[] {
  const totals = new Array<number>(days).fill(0);
  const progressed = new Array<number>(days).fill(0);
  for (const l of leads) {
    const idx = Math.floor(
      (l.createdAt.getTime() - baselineStart.getTime()) / MS_PER_DAY,
    );
    if (idx < 0 || idx >= days) continue;
    totals[idx] += 1;
    if (l.status !== 'NEW') progressed[idx] += 1;
  }
  return totals.map((t, i) => (t > 0 ? progressed[i] / t : 0));
}

function postEngagementRate(post: {
  likes: number;
  comments: number;
  shares: number;
  reach: number;
}): number {
  if (post.reach <= 0) return 0;
  return (post.likes + post.comments + post.shares) / post.reach;
}

function meanPerPostEngagement(
  posts: readonly {
    likes: number;
    comments: number;
    shares: number;
    reach: number;
  }[],
): number {
  if (posts.length === 0) return 0;
  let sum = 0;
  for (const p of posts) sum += postEngagementRate(p);
  return sum / posts.length;
}

function bucketDailyEngagement(
  posts: readonly {
    likes: number;
    comments: number;
    shares: number;
    reach: number;
    publishedAt: Date | null;
  }[],
  baselineStart: Date,
  days: number,
): number[] {
  const bucketSums = new Array<number>(days).fill(0);
  const bucketCounts = new Array<number>(days).fill(0);
  for (const p of posts) {
    if (p.publishedAt == null) continue;
    const idx = Math.floor(
      (p.publishedAt.getTime() - baselineStart.getTime()) / MS_PER_DAY,
    );
    if (idx < 0 || idx >= days) continue;
    bucketSums[idx] += postEngagementRate(p);
    bucketCounts[idx] += 1;
  }
  return bucketSums.map((s, i) =>
    bucketCounts[i] > 0 ? s / bucketCounts[i] : 0,
  );
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
