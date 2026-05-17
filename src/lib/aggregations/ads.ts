/**
 * Ads-scope metrics aggregation for AI insights (SPEC.md §10.3 — "Ads scope").
 *
 * `aggregateAds` snapshots the data Claude needs to analyse paid-acquisition
 * performance over a 7-day window vs. the prior 7 days:
 *
 *   - `summary`     — totals and blended CAC for the current and previous
 *                     period.
 *   - `byChannel`   — per-`CampaignChannel` breakdown of spend, signups,
 *                     conversions, and CAC for the current period.
 *   - `bestCampaign`  — single campaign with the **lowest CAC** (min 10
 *                       signups) in the current period, or `null`.
 *   - `worstCampaign` — single campaign with the **highest CAC** in the
 *                       current period, or `null`.
 *   - `channelRoiRanking` — channels ranked by CAC ascending (best money
 *                       spent first). Excludes `null`-CAC channels.
 *   - `wastedSpend` — INR spent on campaigns whose CAC is >2× the median
 *                       CAC of campaigns on the same channel. Heuristic
 *                       for "likely overspending".
 *   - `channelWoW`  — week-over-week CAC delta per channel.
 *
 * The function is dependency-injected: the caller passes a `PrismaClient`
 * or transactional `Prisma.TransactionClient` so route handlers, the cron
 * job, and tests share one implementation. The return value is a plain
 * JSON-serialisable object (no `Date`, no `BigInt`) suitable for storing
 * in `AIInsight.rawData` and for shipping straight to the Claude prompt.
 *
 * Period membership for a `Campaign` row is "active during the window":
 *   `startDate <= periodEnd && (endDate >= periodStart || endDate IS NULL)`
 *
 * CAC is `spend / signups`, and is `null` whenever `signups === 0` (we
 * never divide by zero). Best/worst selection ignores entries whose CAC
 * is `null` because they can't be ordered.
 */

import type { CampaignChannel, Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal Prisma surface area used by `aggregateAds`. `PrismaClient` and
 * `Prisma.TransactionClient` both satisfy this; tests can pass a stub.
 */
type AdsDbClient = PrismaClient | Prisma.TransactionClient;

/** Per-channel slice of the current period. */
export interface AdsByChannel {
  channel: CampaignChannel;
  spend: number;
  signups: number;
  conversions: number;
  /** `spend / signups`; `null` when signups is 0. */
  cac: number | null;
}

/** Minimal campaign reference used in best/worst picks. */
export interface AdsCampaignPick {
  id: string;
  name: string;
  channel: CampaignChannel;
  /** Always non-null here — campaigns with `null` CAC are excluded from
   *  the best/worst comparison since they can't be ordered. */
  cac: number;
  signups: number;
}

/**
 * One slot in the channel ROI ranking — channels ordered by CAC ascending
 * (lower CAC = better money spent). Channels with `null` CAC (zero signups)
 * are excluded since they can't be ranked.
 */
export interface AdsChannelRoiRank {
  channel: CampaignChannel;
  spend: number;
  signups: number;
  /** Always defined — `null`-CAC channels are filtered out. */
  cac: number;
  /** 1-indexed; `1` is the best (lowest) CAC. */
  rank: number;
  /** Fraction of total period spend on this channel; `0..1`. `0` when
   *  total period spend is also `0` (degenerate but possible). */
  spendShare: number;
}

/**
 * One campaign flagged as "wasted spend" — its CAC is worse (higher) than
 * `2 ×` the median CAC of all current-period campaigns on the same channel.
 */
export interface AdsWastedSpendCampaign {
  id: string;
  name: string;
  cac: number;
  channel: CampaignChannel;
  /** `cac / medianChannelCac` — how many times worse than the channel
   *  median this campaign is. Always strictly greater than 2. */
  multipleOverMedian: number;
}

/** Total INR spent on campaigns flagged as "wasted" plus their identities. */
export interface AdsWastedSpend {
  totalInr: number;
  campaigns: AdsWastedSpendCampaign[];
}

/**
 * Week-over-week CAC comparison for a single channel.
 *
 * Either side can be `null` when the channel had 0 signups in that window
 * (CAC undefined). `deltaPct` is also `null` whenever either side is
 * `null` — the comparison has no meaning without two numbers.
 */
export interface AdsChannelWoW {
  channel: CampaignChannel;
  currentCac: number | null;
  previousCac: number | null;
  /** `(current - previous) / previous`. Fraction (so 0.22 = +22%). `null`
   *  when either side is `null` or `previousCac === 0`. */
  deltaPct: number | null;
}

export interface AdsAggregate {
  summary: {
    totalSpend: number;
    totalSpendPrev: number;
    totalSignups: number;
    totalSignupsPrev: number;
    /** Blended CAC across all channels (`totalSpend / totalSignups`);
     *  `null` when totalSignups is 0. */
    blendedCAC: number | null;
    blendedCACPrev: number | null;
  };
  byChannel: AdsByChannel[];
  bestCampaign: AdsCampaignPick | null;
  worstCampaign: AdsCampaignPick | null;
  /** Channels ranked by CAC ascending. Empty when no channel has a
   *  non-null CAC in the current period. */
  channelRoiRanking: AdsChannelRoiRank[];
  /** Spend on campaigns whose CAC is worse than 2× their channel median. */
  wastedSpend: AdsWastedSpend;
  /** Per-channel week-over-week CAC comparison (current vs. previous). */
  channelWoW: AdsChannelWoW[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot ad-spend metrics for a 7-day window vs. the prior 7 days.
 *
 * @param prisma       any client satisfying {@link AdsDbClient} (DI).
 * @param periodStart  inclusive lower bound for the current window.
 * @param periodEnd    inclusive upper bound for the current window.
 * @param prevStart    inclusive lower bound for the previous window.
 * @param prevEnd      inclusive upper bound for the previous window.
 * @returns a JSON-serialisable {@link AdsAggregate} ready for Claude.
 */
export async function aggregateAds(
  prisma: AdsDbClient,
  periodStart: Date,
  periodEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<AdsAggregate> {
  const currentWhere = activeDuringWindow(periodStart, periodEnd);
  const previousWhere = activeDuringWindow(prevStart, prevEnd);

  // Run independent queries in parallel. Note we now also pull the
  // previous-window campaign rows (id, channel, spent, signups) and the
  // previous-window `groupBy` on channel so we can compute per-channel
  // week-over-week deltas without a third round-trip.
  const [
    currentTotals,
    previousTotals,
    byChannelRaw,
    byChannelPrevRaw,
    currentCampaigns,
  ] = await Promise.all([
    prisma.campaign.aggregate({
      where: currentWhere,
      _sum: { spent: true, signups: true },
    }),
    prisma.campaign.aggregate({
      where: previousWhere,
      _sum: { spent: true, signups: true },
    }),
    prisma.campaign.groupBy({
      by: ['channel'],
      where: currentWhere,
      _sum: { spent: true, signups: true, conversions: true },
    }),
    prisma.campaign.groupBy({
      by: ['channel'],
      where: previousWhere,
      _sum: { spent: true, signups: true },
    }),
    prisma.campaign.findMany({
      where: currentWhere,
      select: {
        id: true,
        name: true,
        channel: true,
        spent: true,
        signups: true,
      },
    }),
  ]);

  const totalSpend = currentTotals._sum.spent ?? 0;
  const totalSignups = currentTotals._sum.signups ?? 0;
  const totalSpendPrev = previousTotals._sum.spent ?? 0;
  const totalSignupsPrev = previousTotals._sum.signups ?? 0;

  const byChannel: AdsByChannel[] = byChannelRaw
    .map((row) => {
      const spend = row._sum.spent ?? 0;
      const signups = row._sum.signups ?? 0;
      const conversions = row._sum.conversions ?? 0;
      return {
        channel: row.channel,
        spend,
        signups,
        conversions,
        cac: cacOf(spend, signups),
      };
    })
    // Stable ordering — biggest spenders first; useful for prompt readability.
    .sort((a, b) => b.spend - a.spend);

  // Best / worst by CAC (campaign-level, current window only).
  // Best: lowest CAC with at least 10 signups (per SPEC §10.3).
  // Worst: highest CAC. Both ignore campaigns with `null` CAC (signups=0).
  let bestCampaign: AdsCampaignPick | null = null;
  let worstCampaign: AdsCampaignPick | null = null;

  for (const c of currentCampaigns) {
    const cac = cacOf(c.spent, c.signups);
    if (cac === null) continue;
    const pick: AdsCampaignPick = {
      id: c.id,
      name: c.name,
      channel: c.channel,
      cac,
      signups: c.signups,
    };
    if (c.signups >= 10 && (bestCampaign === null || cac < bestCampaign.cac)) {
      bestCampaign = pick;
    }
    if (worstCampaign === null || cac > worstCampaign.cac) {
      worstCampaign = pick;
    }
  }

  // Channel ROI ranking — ascending by CAC (lower = better money spent),
  // excluding channels whose CAC is undefined (0 signups). `spendShare`
  // is computed against the period grand-total so it stays comparable
  // even when some channels are filtered out.
  const channelRoiRanking: AdsChannelRoiRank[] = byChannel
    .filter((c): c is AdsByChannel & { cac: number } => c.cac !== null)
    .sort((a, b) => a.cac - b.cac)
    .map((c, idx) => ({
      channel: c.channel,
      spend: c.spend,
      signups: c.signups,
      cac: c.cac,
      rank: idx + 1,
      spendShare: totalSpend > 0 ? c.spend / totalSpend : 0,
    }));

  // Wasted-spend heuristic — flag campaigns whose CAC is worse than 2×
  // the median CAC of campaigns on the same channel. Campaigns with
  // `null` CAC (0 signups) can't be ranked and are excluded from both
  // the median computation and the flagged list.
  const wastedSpend = computeWastedSpend(currentCampaigns);

  // Week-over-week per channel — compute CAC for current AND previous
  // window from the channel-grouped sums, then diff.
  const channelWoW = computeChannelWoW(byChannelRaw, byChannelPrevRaw);

  return {
    summary: {
      totalSpend,
      totalSpendPrev,
      totalSignups,
      totalSignupsPrev,
      blendedCAC: cacOf(totalSpend, totalSignups),
      blendedCACPrev: cacOf(totalSpendPrev, totalSignupsPrev),
    },
    byChannel,
    bestCampaign,
    worstCampaign,
    channelRoiRanking,
    wastedSpend,
    channelWoW,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/** Where-clause matching campaigns active during the window. */
function activeDuringWindow(
  start: Date,
  end: Date,
): Prisma.CampaignWhereInput {
  return {
    startDate: { lte: end },
    OR: [{ endDate: { gte: start } }, { endDate: null }],
  };
}

/** CAC = spend / signups, with `null` when signups is 0. */
function cacOf(spend: number, signups: number): number | null {
  if (signups <= 0) return null;
  return spend / signups;
}

/**
 * Median of an array of finite numbers. The caller is expected to filter
 * out `null` / `undefined` before calling; we don't accept them here so
 * the type forces the right call site shape.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Build the {@link AdsWastedSpend} block. Per channel, compute the median
 * CAC across campaigns with a defined CAC. Any campaign whose CAC exceeds
 * `2 × medianChannelCac` is flagged; its spend contributes to `totalInr`.
 *
 * Channels with fewer than 2 campaigns of defined CAC are skipped — a
 * single data point has no meaningful "median" to compare against, and
 * flagging the only campaign as wasted would be a false positive.
 */
function computeWastedSpend(
  campaigns: readonly {
    id: string;
    name: string;
    channel: CampaignChannel;
    spent: number;
    signups: number;
  }[],
): AdsWastedSpend {
  // Group campaigns with defined CAC by channel.
  const byChannelCampaigns = new Map<
    CampaignChannel,
    {
      id: string;
      name: string;
      channel: CampaignChannel;
      spent: number;
      cac: number;
    }[]
  >();
  for (const c of campaigns) {
    const cac = cacOf(c.spent, c.signups);
    if (cac === null) continue;
    const arr = byChannelCampaigns.get(c.channel) ?? [];
    arr.push({
      id: c.id,
      name: c.name,
      channel: c.channel,
      spent: c.spent,
      cac,
    });
    byChannelCampaigns.set(c.channel, arr);
  }

  const flagged: AdsWastedSpendCampaign[] = [];
  let totalInr = 0;

  for (const [, channelCampaigns] of byChannelCampaigns) {
    // Need at least 2 data points to make "2× median" meaningful.
    if (channelCampaigns.length < 2) continue;
    const med = median(channelCampaigns.map((c) => c.cac));
    if (med <= 0) continue;
    const threshold = 2 * med;
    for (const c of channelCampaigns) {
      if (c.cac > threshold) {
        flagged.push({
          id: c.id,
          name: c.name,
          cac: c.cac,
          channel: c.channel,
          multipleOverMedian: c.cac / med,
        });
        totalInr += c.spent;
      }
    }
  }

  // Stable order — worst offenders (highest multiple) first.
  flagged.sort((a, b) => b.multipleOverMedian - a.multipleOverMedian);

  return { totalInr, campaigns: flagged };
}

/**
 * Diff per-channel CAC between current and previous windows. Returns one
 * entry per channel that appears in **either** window — channels active
 * only in the previous window still surface (with `currentCac: null`) so
 * Claude can mention "Google Ads stopped spending this week".
 */
function computeChannelWoW(
  currentGroups: readonly {
    channel: CampaignChannel;
    _sum: { spent: number | null; signups: number | null };
  }[],
  previousGroups: readonly {
    channel: CampaignChannel;
    _sum: { spent: number | null; signups: number | null };
  }[],
): AdsChannelWoW[] {
  const cacByChannel = new Map<
    CampaignChannel,
    { current: number | null; previous: number | null }
  >();

  for (const row of currentGroups) {
    cacByChannel.set(row.channel, {
      current: cacOf(row._sum.spent ?? 0, row._sum.signups ?? 0),
      previous: null,
    });
  }
  for (const row of previousGroups) {
    const prevCac = cacOf(row._sum.spent ?? 0, row._sum.signups ?? 0);
    const existing = cacByChannel.get(row.channel);
    if (existing) {
      existing.previous = prevCac;
    } else {
      cacByChannel.set(row.channel, { current: null, previous: prevCac });
    }
  }

  const out: AdsChannelWoW[] = [];
  for (const [channel, { current, previous }] of cacByChannel) {
    let deltaPct: number | null = null;
    if (current !== null && previous !== null && previous > 0) {
      deltaPct = (current - previous) / previous;
    }
    out.push({
      channel,
      currentCac: current,
      previousCac: previous,
      deltaPct,
    });
  }

  // Stable order — channels with a meaningful delta (biggest absolute %
  // change) first, then channels with one-sided data, then everything
  // else. This puts the most newsworthy comparisons at the top of the
  // payload Claude sees.
  out.sort((a, b) => {
    const aHas = a.deltaPct !== null;
    const bHas = b.deltaPct !== null;
    if (aHas && bHas) {
      return Math.abs(b.deltaPct as number) - Math.abs(a.deltaPct as number);
    }
    if (aHas) return -1;
    if (bHas) return 1;
    return 0;
  });

  return out;
}
