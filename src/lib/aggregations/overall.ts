/**
 * Overall-scope metrics aggregation for AI insights (SPEC.md §10.3 — "Overall scope").
 *
 * `aggregateOverall` snapshots a cross-module digest for the AI prompt:
 *
 *   - `summary`               — current vs. previous totals for the four
 *                               headline metrics (new leads, campaign
 *                               spend, posts published, dev tasks
 *                               completed).
 *   - `socialReachVsLeads`    — coarse cross-scope signal Claude can latch
 *                               onto: does social reach move with new
 *                               leads?
 *                                 - `'aligned'`   — same sign, both
 *                                                   |% change| > 5%.
 *                                 - `'diverging'` — opposite signs, at
 *                                                   least one |% change|
 *                                                   > 5%.
 *                                 - `'flat'`      — neither metric moved
 *                                                   > 5% (or comparison
 *                                                   undefined when prev
 *                                                   = 0 on both sides).
 *   - `correlations`          — cross-module patterns Claude can narrate
 *                               in plain English (e.g. "campaign X drove
 *                               40 leads but only 2% converted"). Empty
 *                               array when no heuristic fires.
 *   - `recentRelease`         — most recent DevTask with type=RELEASE
 *                               within the last 30 days, plus a count of
 *                               BUG tasks reported within 7 days after.
 *   - `topPerformerOwner`     — owner with the most leads converted in
 *                               the period, plus the median across all
 *                               owners with >0 conversions.
 *
 * Lead and post counts are computed from the obvious "in window"
 * predicates (`createdAt` for leads, `publishedAt + status='PUBLISHED'`
 * for posts). Campaign spend uses the same "active during window" filter
 * the ads aggregation uses (start <= end && (endDate >= start || NULL))
 * so the two scopes agree. Dev tasks count rows whose `completedAt` falls
 * in the window — this matches the semantics SPEC.md §11 already uses
 * elsewhere.
 *
 * The function is dependency-injected: pass a `PrismaClient` or
 * `Prisma.TransactionClient`. The return value is plain JSON (no `Date`,
 * no `BigInt`) and safe to store in `AIInsight.rawData`.
 */

import type { CampaignChannel, Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OverallDbClient = PrismaClient | Prisma.TransactionClient;

export type CorrelationFlag = 'aligned' | 'diverging' | 'flat';

export type CorrelationKind =
  | 'social_to_leads'
  | 'campaign_to_conversion'
  | 'release_to_metrics'
  | 'channel_quality_mismatch';

export type CorrelationConfidence = 'low' | 'medium' | 'high';

/**
 * One cross-module pattern Claude can narrate. Each correlation captures
 * a human-readable description plus the raw evidence backing it so the
 * narrative can quote the numbers verbatim.
 */
export interface Correlation {
  kind: CorrelationKind;
  /** One-sentence summary — Claude is told to riff on this verbatim. */
  description: string;
  /** Raw numbers backing the claim. Keys are stable per `kind` so
   *  consumers can pull specific fields out if needed. */
  evidence: Record<string, number | string>;
  confidence: CorrelationConfidence;
}

/**
 * Most recent DevTask of type=RELEASE within the last 30 days plus a
 * "bugs reported in the following 7 days" signal.
 */
export interface RecentRelease {
  version: string;
  /** ISO 8601 string — never a `Date` (the payload is JSON-serialised). */
  releasedAt: string;
  /** Count of DevTask rows with `type='BUG'` created in the 7 days after
   *  `releasedAt`. A leading indicator of release quality. */
  bugsReportedAfter: number;
}

/**
 * Owner with the most leads converted (`status='CONVERTED'` AND
 * `convertedAt` in the period) plus the median across all owners with
 * at least one conversion. `null` when no conversions happened in the
 * window.
 */
export interface TopPerformerOwner {
  userId: string;
  userName: string;
  leadsConverted: number;
  medianLeadsConvertedAcrossOwners: number;
}

export interface OverallAggregate {
  summary: {
    leads: { current: number; previous: number };
    campaignSpend: { current: number; previous: number };
    postsPublished: { current: number; previous: number };
    devTasksCompleted: { current: number; previous: number };
  };
  /**
   * Legacy single-flag correlation kept for backward compatibility with
   * the original SPEC §10.3 wording. Newer cross-module patterns live in
   * the `correlations` array below.
   */
  correlations: Correlation[];
  /** Legacy correlation flag — does social reach move with new leads? */
  socialReachVsLeads: CorrelationFlag;
  recentRelease: RecentRelease | null;
  topPerformerOwner: TopPerformerOwner | null;
}

/** Threshold for "moved" — anything ≤5% counts as flat. SPEC §10.3. */
const FLAT_THRESHOLD = 0.05;

/** Heuristic thresholds for the social_to_leads correlation. */
const SOCIAL_REACH_UPLIFT = 0.15;
const LEAD_UPLIFT = 0.1;

/** Heuristic threshold for the campaign_to_conversion correlation. */
const CAMPAIGN_MIN_LEADS = 20;
const CAMPAIGN_LOW_CONVERSION = 0.05;

/** How far back to scan for a recent release. */
const RECENT_RELEASE_LOOKBACK_DAYS = 30;
const POST_RELEASE_BUG_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot cross-module headline numbers, one correlation flag, and a
 * handful of cross-module narrative inputs for the AI prompt.
 *
 * @param prisma       any client satisfying {@link OverallDbClient} (DI).
 * @param periodStart  inclusive lower bound for the current window.
 * @param periodEnd    inclusive upper bound for the current window.
 * @param prevStart    inclusive lower bound for the previous window.
 * @param prevEnd      inclusive upper bound for the previous window.
 * @returns a JSON-serialisable {@link OverallAggregate} ready for Claude.
 */
export async function aggregateOverall(
  prisma: OverallDbClient,
  periodStart: Date,
  periodEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<OverallAggregate> {
  const currentCampaignWhere = activeDuringWindow(periodStart, periodEnd);
  const previousCampaignWhere = activeDuringWindow(prevStart, prevEnd);

  // Prior-prior window: same duration as previous, ending 1 ms before
  // `prevStart`. Used to detect social reach uplift in the *previous*
  // window vs. the one before that (the lead "follow-up" lives in the
  // current window).
  const prevDurationMs = prevEnd.getTime() - prevStart.getTime();
  const priorPriorEnd = new Date(prevStart.getTime() - 1);
  const priorPriorStart = new Date(priorPriorEnd.getTime() - prevDurationMs);

  // Recent release lookback — independent of the analysis window because
  // a release that shipped 10 days ago is still "recent" even if our
  // current 7-day window starts today.
  const releaseLookbackStart = new Date(
    periodEnd.getTime() - RECENT_RELEASE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const [
    leadsCurrent,
    leadsPrevious,
    campaignSpendCurrent,
    campaignSpendPrevious,
    postsCurrent,
    postsPrevious,
    devTasksCurrent,
    devTasksPrevious,
    socialReachCurrent,
    socialReachPrevious,
    socialReachPriorPrior,
    leadsByCampaignRaw,
    leadsBySourceRaw,
    leadsBySourceConvertedRaw,
    campaignsCurrentForChannel,
    recentRelease,
    leadsConvertedByOwnerRaw,
  ] = await Promise.all([
    prisma.lead.count({
      where: { createdAt: { gte: periodStart, lte: periodEnd } },
    }),
    prisma.lead.count({
      where: { createdAt: { gte: prevStart, lte: prevEnd } },
    }),
    prisma.campaign.aggregate({
      where: currentCampaignWhere,
      _sum: { spent: true },
    }),
    prisma.campaign.aggregate({
      where: previousCampaignWhere,
      _sum: { spent: true },
    }),
    prisma.socialPost.count({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    prisma.socialPost.count({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: prevStart, lte: prevEnd },
      },
    }),
    prisma.devTask.count({
      where: {
        status: 'DONE',
        completedAt: { gte: periodStart, lte: periodEnd },
      },
    }),
    prisma.devTask.count({
      where: {
        status: 'DONE',
        completedAt: { gte: prevStart, lte: prevEnd },
      },
    }),
    // Reach totals power the cross-scope correlation flag below; keep the
    // queries isolated from the aggregations above so social.ts changes
    // don't leak in via shared helpers.
    prisma.socialPost.aggregate({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: periodStart, lte: periodEnd },
      },
      _sum: { reach: true },
    }),
    prisma.socialPost.aggregate({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: prevStart, lte: prevEnd },
      },
      _sum: { reach: true },
    }),
    prisma.socialPost.aggregate({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: priorPriorStart, lte: priorPriorEnd },
      },
      _sum: { reach: true },
    }),
    // Lead → campaign attribution via `utmCampaign`. Only count leads
    // created in the current window so the conversion rate reflects the
    // analysis period.
    prisma.lead.groupBy({
      by: ['utmCampaign'],
      where: {
        createdAt: { gte: periodStart, lte: periodEnd },
        utmCampaign: { not: null },
      },
      _count: { _all: true },
    }),
    // Lead by source (current window) — used for the
    // channel_quality_mismatch correlation.
    prisma.lead.groupBy({
      by: ['source'],
      where: { createdAt: { gte: periodStart, lte: periodEnd } },
      _count: { _all: true },
    }),
    // Lead by source AND converted-in-window — denominator/numerator for
    // per-source conversion rate.
    prisma.lead.groupBy({
      by: ['source'],
      where: {
        createdAt: { gte: periodStart, lte: periodEnd },
        status: 'CONVERTED',
      },
      _count: { _all: true },
    }),
    // Spend per channel in the current window so we can find the
    // highest-spend channel.
    prisma.campaign.groupBy({
      by: ['channel'],
      where: currentCampaignWhere,
      _sum: { spent: true },
    }),
    // Most recent release within the last 30 days. We only need the
    // version and the timestamp; we'll count bugs after the fact.
    prisma.devTask.findFirst({
      where: {
        type: 'RELEASE',
        releasedAt: { not: null, gte: releaseLookbackStart, lte: periodEnd },
      },
      orderBy: { releasedAt: 'desc' },
      select: { releaseVersion: true, releasedAt: true },
    }),
    // Per-owner conversion counts in the window. `null`-ownerId leads
    // are excluded since "Unassigned" isn't a person we can credit.
    prisma.lead.groupBy({
      by: ['ownerId'],
      where: {
        status: 'CONVERTED',
        convertedAt: { gte: periodStart, lte: periodEnd },
        ownerId: { not: null },
      },
      _count: { _all: true },
    }),
  ]);

  const reachPctChange = pctChange(
    socialReachCurrent._sum.reach ?? 0,
    socialReachPrevious._sum.reach ?? 0,
  );
  const leadsPctChange = pctChange(leadsCurrent, leadsPrevious);

  // ---- secondary lookups that depend on the primary results ----
  const releaseInfo = await buildRecentRelease(prisma, recentRelease);
  const topPerformerOwner = await buildTopPerformer(
    prisma,
    leadsConvertedByOwnerRaw,
  );

  // ---- correlations ----
  // Each helper returns `null` when its heuristic doesn't fire; we
  // filter those out to keep the array compact (per-instruction: "omit
  // from the array when not computable").
  const reachPrevPctChange = pctChange(
    socialReachPrevious._sum.reach ?? 0,
    socialReachPriorPrior._sum.reach ?? 0,
  );
  const correlations: Correlation[] = [];

  const socialToLeads = buildSocialToLeads(
    reachPrevPctChange,
    leadsPctChange,
    socialReachPrevious._sum.reach ?? 0,
    socialReachPriorPrior._sum.reach ?? 0,
    leadsCurrent,
    leadsPrevious,
  );
  if (socialToLeads) correlations.push(socialToLeads);

  const campaignsBySpend = await buildCampaignAttribution(
    prisma,
    leadsByCampaignRaw,
    periodStart,
    periodEnd,
  );
  if (campaignsBySpend) correlations.push(campaignsBySpend);

  if (releaseInfo) {
    const releaseMetrics = buildReleaseToMetrics(
      releaseInfo,
      leadsCurrent,
      leadsPrevious,
    );
    if (releaseMetrics) correlations.push(releaseMetrics);
  }

  const channelMismatch = buildChannelQualityMismatch(
    campaignsCurrentForChannel,
    leadsBySourceRaw,
    leadsBySourceConvertedRaw,
  );
  if (channelMismatch) correlations.push(channelMismatch);

  return {
    summary: {
      leads: { current: leadsCurrent, previous: leadsPrevious },
      campaignSpend: {
        current: campaignSpendCurrent._sum.spent ?? 0,
        previous: campaignSpendPrevious._sum.spent ?? 0,
      },
      postsPublished: { current: postsCurrent, previous: postsPrevious },
      devTasksCompleted: {
        current: devTasksCurrent,
        previous: devTasksPrevious,
      },
    },
    correlations,
    socialReachVsLeads: classifyCorrelation(reachPctChange, leadsPctChange),
    recentRelease: releaseInfo,
    topPerformerOwner,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure & near-pure)
// ---------------------------------------------------------------------------

function activeDuringWindow(
  start: Date,
  end: Date,
): Prisma.CampaignWhereInput {
  return {
    startDate: { lte: end },
    OR: [{ endDate: { gte: start } }, { endDate: null }],
  };
}

/**
 * Percent change `(current - previous) / previous` as a fraction (so 0.18
 * = +18%). Returns `null` when `previous` is `0`, which the caller
 * interprets as "no comparison signal".
 */
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * Classify two percent-change signals as `aligned` / `diverging` / `flat`.
 *
 * Rules (SPEC.md §10.3 — overall correlations):
 *   - same sign and **both** |Δ| > 5%       → `'aligned'`
 *   - opposite signs and **at least one**
 *     |Δ| > 5%                             → `'diverging'`
 *   - everything else                       → `'flat'`
 *
 * `null` (i.e. the previous period had a 0 baseline) is treated as a
 * non-signal: it can't be aligned or diverging on its own, so the result
 * is `'flat'` unless the *other* axis carries a clear opposite-sign move.
 * To avoid spurious correlations, when one side is `null` we never flag
 * `'aligned'`; we only flag `'diverging'` if the other side moved >5%
 * **and** is itself not null. In practice the `null` branch always falls
 * through to `'flat'`.
 */
function classifyCorrelation(
  reachPct: number | null,
  leadsPct: number | null,
): CorrelationFlag {
  if (reachPct === null || leadsPct === null) return 'flat';

  const reachMoved = Math.abs(reachPct) > FLAT_THRESHOLD;
  const leadsMoved = Math.abs(leadsPct) > FLAT_THRESHOLD;
  const sameSign = Math.sign(reachPct) === Math.sign(leadsPct);

  if (sameSign && reachMoved && leadsMoved) return 'aligned';
  if (!sameSign && (reachMoved || leadsMoved)) return 'diverging';
  return 'flat';
}

/** Compute the median of a non-empty array of finite numbers. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Heuristic mapping `LeadSource` → most likely `CampaignChannel`. This is
 * imperfect — a lead from `FACEBOOK_AD` could in principle come from a
 * Google campaign if utm tracking is off — but matches the obvious
 * customer-mental-model for the `channel_quality_mismatch` correlation.
 * Sources without an obvious paid-channel mapping return `null` and are
 * excluded from the mismatch comparison.
 */
function leadSourceToChannel(source: string): CampaignChannel | null {
  switch (source) {
    case 'FACEBOOK_AD':
      return 'META_ADS';
    case 'GOOGLE_AD':
      return 'GOOGLE_ADS';
    case 'INSTAGRAM':
      return 'INSTAGRAM_ORGANIC';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Correlation builders — each returns `null` to be filtered out of the
// final array when its heuristic doesn't fire.
// ---------------------------------------------------------------------------

/**
 * Did the previous period's social-reach uplift translate into a
 * lead-volume uplift in the current period?
 *
 * Heuristic: previous-week reach (vs. prior-prior week) >15% up AND
 * current-week leads (vs. previous week) >10% up.
 */
function buildSocialToLeads(
  reachPrevPctChange: number | null,
  leadsPctChange: number | null,
  reachPrev: number,
  reachPriorPrior: number,
  leadsCurrent: number,
  leadsPrevious: number,
): Correlation | null {
  if (reachPrevPctChange === null || leadsPctChange === null) return null;
  if (reachPrevPctChange <= SOCIAL_REACH_UPLIFT) return null;
  if (leadsPctChange <= LEAD_UPLIFT) return null;

  const reachPct = Math.round(reachPrevPctChange * 100);
  const leadsPct = Math.round(leadsPctChange * 100);

  return {
    kind: 'social_to_leads',
    description: `Social reach grew ${reachPct}% last week and new leads grew ${leadsPct}% this week — possible carryover effect.`,
    evidence: {
      reachPrevPeriod: reachPrev,
      reachPriorPriorPeriod: reachPriorPrior,
      reachUpliftPct: reachPct,
      leadsCurrentPeriod: leadsCurrent,
      leadsPreviousPeriod: leadsPrevious,
      leadsUpliftPct: leadsPct,
    },
    // Confidence reflects sample size — small absolute numbers should
    // not get a "high" label even if the percentage uplift is large.
    confidence:
      leadsCurrent >= 50 && reachPrev >= 5000
        ? 'high'
        : leadsCurrent >= 10
          ? 'medium'
          : 'low',
  };
}

/**
 * Find the campaign with the worst leads-to-conversion ratio in the
 * current period. Threshold: >20 leads attributed to the campaign but
 * <5% of them converted.
 *
 * Returns `null` when no such campaign exists or when the campaign name
 * lookup fails (defensive — `utmCampaign` is `@unique` in the schema).
 */
async function buildCampaignAttribution(
  prisma: OverallDbClient,
  leadsByCampaignRaw: readonly {
    utmCampaign: string | null;
    _count: { _all: number };
  }[],
  periodStart: Date,
  periodEnd: Date,
): Promise<Correlation | null> {
  // Filter to campaigns with enough leads to be statistically meaningful.
  const candidates = leadsByCampaignRaw.filter(
    (r) => r.utmCampaign !== null && r._count._all >= CAMPAIGN_MIN_LEADS,
  );
  if (candidates.length === 0) return null;

  // For each candidate, count converted leads in the same window.
  const utmKeys = candidates
    .map((c) => c.utmCampaign)
    .filter((k): k is string => k !== null);

  const convertedCounts = await prisma.lead.groupBy({
    by: ['utmCampaign'],
    where: {
      createdAt: { gte: periodStart, lte: periodEnd },
      utmCampaign: { in: utmKeys },
      status: 'CONVERTED',
    },
    _count: { _all: true },
  });
  const convertedByUtm = new Map<string, number>();
  for (const r of convertedCounts) {
    if (r.utmCampaign !== null) {
      convertedByUtm.set(r.utmCampaign, r._count._all);
    }
  }

  // Find the worst-converting campaign that crosses the low-conversion
  // threshold. Stable tiebreak — biggest lead volume wins (more wasted).
  let worst: {
    utmCampaign: string;
    leads: number;
    converted: number;
    rate: number;
  } | null = null;

  for (const c of candidates) {
    if (c.utmCampaign === null) continue;
    const converted = convertedByUtm.get(c.utmCampaign) ?? 0;
    const rate = converted / c._count._all;
    if (rate >= CAMPAIGN_LOW_CONVERSION) continue;
    if (
      worst === null ||
      rate < worst.rate ||
      (rate === worst.rate && c._count._all > worst.leads)
    ) {
      worst = {
        utmCampaign: c.utmCampaign,
        leads: c._count._all,
        converted,
        rate,
      };
    }
  }

  if (worst === null) return null;

  // Resolve the campaign's human-readable name. `utmCampaign` is
  // `@unique` on the Campaign model so this is at most one row.
  const campaign = await prisma.campaign.findFirst({
    where: { utmCampaign: worst.utmCampaign },
    select: { id: true, name: true },
  });
  const campaignName = campaign?.name ?? worst.utmCampaign;

  return {
    kind: 'campaign_to_conversion',
    description: `Campaign "${campaignName}" attributed ${worst.leads} leads but only ${worst.converted} converted (${Math.round(worst.rate * 100)}%) — likely audience/creative mismatch.`,
    evidence: {
      campaignName,
      utmCampaign: worst.utmCampaign,
      leads: worst.leads,
      converted: worst.converted,
      conversionRatePct: Math.round(worst.rate * 1000) / 10, // 1 decimal place
    },
    confidence: worst.leads >= 50 ? 'high' : 'medium',
  };
}

/**
 * Surface the impact of the most recent release on lead-volume metrics.
 * Heuristic is intentionally loose — Claude can riff on the raw numbers
 * but we provide a single-line summary it can use as-is.
 */
function buildReleaseToMetrics(
  release: RecentRelease,
  leadsCurrent: number,
  leadsPrevious: number,
): Correlation | null {
  // Always emit when there's a recent release — Claude wants the signal.
  const leadsDeltaPct = pctChange(leadsCurrent, leadsPrevious);
  const leadsDeltaStr =
    leadsDeltaPct === null
      ? 'baseline'
      : `${leadsDeltaPct >= 0 ? '+' : ''}${Math.round(leadsDeltaPct * 100)}%`;

  return {
    kind: 'release_to_metrics',
    description: `Release ${release.version} shipped ${release.releasedAt}. Post-release: ${release.bugsReportedAfter} bugs reported within 7 days, lead volume ${leadsDeltaStr} vs prior period.`,
    evidence: {
      version: release.version,
      releasedAt: release.releasedAt,
      bugsReportedAfter: release.bugsReportedAfter,
      leadsCurrentPeriod: leadsCurrent,
      leadsPreviousPeriod: leadsPrevious,
      leadsDeltaPct:
        leadsDeltaPct === null ? 0 : Math.round(leadsDeltaPct * 1000) / 10,
    },
    confidence: release.bugsReportedAfter >= 5 ? 'high' : 'medium',
  };
}

/**
 * Find a channel that combines the highest spend with the lowest
 * conversion rate among leads attributed to that channel — a classic
 * "you're paying for traffic that doesn't close" pattern.
 */
function buildChannelQualityMismatch(
  campaignsByChannel: readonly {
    channel: CampaignChannel;
    _sum: { spent: number | null };
  }[],
  leadsBySource: readonly {
    source: string;
    _count: { _all: number };
  }[],
  leadsConvertedBySource: readonly {
    source: string;
    _count: { _all: number };
  }[],
): Correlation | null {
  if (campaignsByChannel.length === 0 || leadsBySource.length === 0) {
    return null;
  }

  // Channel with the highest spend.
  let highestSpendChannel: { channel: CampaignChannel; spend: number } | null =
    null;
  for (const row of campaignsByChannel) {
    const spend = row._sum.spent ?? 0;
    if (spend <= 0) continue;
    if (highestSpendChannel === null || spend > highestSpendChannel.spend) {
      highestSpendChannel = { channel: row.channel, spend };
    }
  }
  if (highestSpendChannel === null) return null;

  // Per-source conversion rate.
  const totalBySource = new Map<string, number>();
  for (const r of leadsBySource) totalBySource.set(r.source, r._count._all);
  const convertedBySource = new Map<string, number>();
  for (const r of leadsConvertedBySource) {
    convertedBySource.set(r.source, r._count._all);
  }

  // Compute conversion rate for every source with leads; find the worst.
  let lowestConvSource: {
    source: string;
    channel: CampaignChannel;
    total: number;
    converted: number;
    rate: number;
  } | null = null;
  for (const [source, total] of totalBySource) {
    if (total === 0) continue;
    const channel = leadSourceToChannel(source);
    if (channel === null) continue;
    const converted = convertedBySource.get(source) ?? 0;
    const rate = converted / total;
    if (
      lowestConvSource === null ||
      rate < lowestConvSource.rate ||
      (rate === lowestConvSource.rate && total > lowestConvSource.total)
    ) {
      lowestConvSource = { source, channel, total, converted, rate };
    }
  }
  if (lowestConvSource === null) return null;

  // Only emit when the highest-spend channel is ALSO the lowest-
  // converting one — that's the actionable mismatch.
  if (lowestConvSource.channel !== highestSpendChannel.channel) return null;

  return {
    kind: 'channel_quality_mismatch',
    description: `${highestSpendChannel.channel} has the highest spend (₹${Math.round(highestSpendChannel.spend)}) yet the lowest lead conversion rate (${Math.round(lowestConvSource.rate * 100)}% of ${lowestConvSource.total} leads).`,
    evidence: {
      channel: highestSpendChannel.channel,
      spend: highestSpendChannel.spend,
      leadSource: lowestConvSource.source,
      totalLeads: lowestConvSource.total,
      convertedLeads: lowestConvSource.converted,
      conversionRatePct: Math.round(lowestConvSource.rate * 1000) / 10,
    },
    confidence: lowestConvSource.total >= 30 ? 'high' : 'medium',
  };
}

// ---------------------------------------------------------------------------
// Secondary-lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the most-recent release into a {@link RecentRelease} block,
 * including a count of BUG tasks reported in the 7 days after it shipped.
 * Returns `null` when no eligible release exists or its fields are
 * malformed (defensive — `releasedAt` could be `null` despite our `where`).
 */
async function buildRecentRelease(
  prisma: OverallDbClient,
  release: { releaseVersion: string | null; releasedAt: Date | null } | null,
): Promise<RecentRelease | null> {
  if (release === null || release.releasedAt === null) return null;
  const version = release.releaseVersion ?? 'unversioned';

  const windowEnd = new Date(
    release.releasedAt.getTime() +
      POST_RELEASE_BUG_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const bugsReportedAfter = await prisma.devTask.count({
    where: {
      type: 'BUG',
      createdAt: { gte: release.releasedAt, lte: windowEnd },
    },
  });

  return {
    version,
    releasedAt: release.releasedAt.toISOString(),
    bugsReportedAfter,
  };
}

/**
 * Resolve the top-performing owner (most conversions in the window) plus
 * the median conversion count across all owners with >0 conversions.
 * Returns `null` when no conversions happened or the owner row can't be
 * loaded (defensive).
 */
async function buildTopPerformer(
  prisma: OverallDbClient,
  groups: readonly {
    ownerId: string | null;
    _count: { _all: number };
  }[],
): Promise<TopPerformerOwner | null> {
  const positive = groups
    .filter(
      (g): g is { ownerId: string; _count: { _all: number } } =>
        g.ownerId !== null && g._count._all > 0,
    )
    .sort((a, b) => b._count._all - a._count._all);
  if (positive.length === 0) return null;

  const top = positive[0];
  const med = median(positive.map((g) => g._count._all));

  const owner = await prisma.user.findUnique({
    where: { id: top.ownerId },
    select: { id: true, name: true },
  });
  if (owner === null) return null;

  return {
    userId: owner.id,
    userName: owner.name,
    leadsConverted: top._count._all,
    medianLeadsConvertedAcrossOwners: med,
  };
}
