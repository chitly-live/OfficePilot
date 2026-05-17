/**
 * Dashboard data loaders (SPEC.md §11.1).
 *
 * Server-side data functions that the unified dashboard page composes
 * into its four widget rows. Each loader is dependency-injected — pass
 * a `PrismaClient` or a `Prisma.TransactionClient`; the caller (the
 * `/dashboard` Server Component) supplies the singleton from
 * `@/lib/db`. Keeping the loaders DI-friendly means tests and
 * transaction-scoped jobs can reuse them without monkey-patching.
 *
 * Row → loader mapping (SPEC.md §11.1):
 *
 *   - Row 1 "Today's pulse"           → {@link loadTodaysPulse}
 *   - Row 2 "Latest AI insights"      → {@link loadLatestInsights}
 *   - Row 3 "Release + Campaign       → {@link loadTimeline}
 *           Timeline"
 *   - Row 4 "Quick actions +          → {@link loadFollowUps}
 *           Reminders" follow-up
 *           buckets
 *
 * Each loader uses `Promise.all` internally to dispatch the queries it
 * needs concurrently. The page is responsible for paralleling across
 * loaders — it can call all four under one outer `Promise.all` so the
 * dashboard's first-byte time is the slowest single loader, not the
 * sum.
 *
 * Return values intentionally keep `Date` objects (not ISO strings) —
 * these loaders are server-only and feed React Server Components,
 * which serialise `Date` values to client islands transparently. This
 * matches the convention used in `src/lib/aggregations/*.ts`.
 *
 * The widget components (tasks 75–78) and the page itself (task 79)
 * consume these return shapes directly.
 */

import { startOfDay, subDays } from 'date-fns';
import type {
  AIInsight,
  CampaignChannel,
  CampaignStatus,
  DevTaskStatus,
  LeadStatus,
  Prisma,
  PrismaClient,
  SocialPlatform,
} from '@prisma/client';

import { ACTIVITY_ACTIONS } from '@/lib/activity';

// ---------------------------------------------------------------------------
// DI client type
// ---------------------------------------------------------------------------

/**
 * Any object that exposes the Prisma model surfaces these loaders touch.
 * `PrismaClient` and `Prisma.TransactionClient` both satisfy it; tests
 * can also pass a structural mock without constructing a real client.
 */
type DashboardDbClient = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Row 1 — Today's pulse
// ---------------------------------------------------------------------------

/**
 * Per-platform breakdown of today's published posts. Always carries a
 * key for every {@link SocialPlatform} so consumers can render a stable
 * row of icons without optional-chaining the count.
 */
export type PostsByPlatform = Record<SocialPlatform, number>;

/**
 * Today's pulse widget data (SPEC.md §11.1 row 1 — "Today's pulse").
 *
 *   - `newLeadsToday` / `newLeadsYesterday`
 *       Counts of `Lead` rows by `createdAt` — the widget renders
 *       today plus the day-over-day delta.
 *   - `adSpendToday` / `adSpendYesterday`
 *       Sum of `metadata.delta` from `ActivityLog` rows with action
 *       `campaign.spent_updated` created today/yesterday. This is the
 *       *change* in spend logged by users that day, not lifetime spend
 *       on active campaigns. See note in {@link loadTodaysPulse}.
 *   - `postsPublishedToday`
 *       Total count plus a per-platform breakdown for `SocialPost`
 *       rows with `status = 'PUBLISHED'` and `publishedAt` today.
 *   - `openDevTasks`
 *       `total`     — count of TODO + DOING tasks.
 *       `inProgress` — count of DOING tasks (subset of `total`).
 */
export interface TodaysPulse {
  newLeadsToday: number;
  newLeadsYesterday: number;
  adSpendToday: number;
  adSpendYesterday: number;
  postsPublishedToday: {
    total: number;
    byPlatform: PostsByPlatform;
  };
  openDevTasks: {
    total: number;
    inProgress: number;
  };
}

/** Every member of the `SocialPlatform` enum, used to seed
 *  {@link PostsByPlatform} so the shape is stable. */
const ALL_SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  'INSTAGRAM',
  'FACEBOOK',
  'TWITTER',
  'LINKEDIN',
  'YOUTUBE',
  'THREADS',
];

/** Open dev-task statuses (TODO + DOING). */
const OPEN_DEV_TASK_STATUSES: readonly DevTaskStatus[] = ['TODO', 'DOING'];

/**
 * Load the four headline numbers behind Row 1 of the dashboard
 * (SPEC.md §11.1 — "Today's pulse").
 *
 * "Today" / "yesterday" are cut at `startOfDay(now)` and
 * `startOfDay(now - 1 day)` so the widget is stable across multiple
 * calls in the same calendar day.
 *
 * Ad spend uses the {@link ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED}
 * activity log rather than `Campaign.spent` directly: the column
 * stores lifetime spend, but the widget wants *today's* spend
 * delta. Each `campaign.spent_updated` row carries `{ delta: number }`
 * in its `metadata` JSON (see `CampaignSpentUpdatedMeta` in
 * `src/lib/activity.ts`); we sum those deltas across rows created
 * within the relevant day-window.
 *
 * All five queries fire in parallel via `Promise.all`.
 *
 * @param prisma DI client (PrismaClient, transaction client, or
 *               compatible mock).
 * @returns a {@link TodaysPulse} ready to feed `<TodayPulse>` (task 75).
 */
export async function loadTodaysPulse(
  prisma: DashboardDbClient,
): Promise<TodaysPulse> {
  const now = new Date();
  const startOfToday = startOfDay(now);
  const startOfYesterday = startOfDay(subDays(now, 1));

  const spentUpdatedAction = ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED;

  const [
    newLeadsToday,
    newLeadsYesterday,
    spentUpdatesToday,
    spentUpdatesYesterday,
    publishedTodayRows,
    openDevTaskGroups,
  ] = await Promise.all([
    prisma.lead.count({
      where: { createdAt: { gte: startOfToday } },
    }),
    prisma.lead.count({
      where: {
        createdAt: { gte: startOfYesterday, lt: startOfToday },
      },
    }),
    prisma.activityLog.findMany({
      where: {
        action: spentUpdatedAction,
        createdAt: { gte: startOfToday },
      },
      select: { metadata: true },
    }),
    prisma.activityLog.findMany({
      where: {
        action: spentUpdatedAction,
        createdAt: { gte: startOfYesterday, lt: startOfToday },
      },
      select: { metadata: true },
    }),
    prisma.socialPost.findMany({
      where: {
        status: 'PUBLISHED',
        publishedAt: { gte: startOfToday },
      },
      select: { platform: true },
    }),
    // One `groupBy` covers both "open total" and "in progress" — fold
    // the two TODO/DOING rows in JS rather than firing two counts.
    prisma.devTask.groupBy({
      by: ['status'],
      where: { status: { in: [...OPEN_DEV_TASK_STATUSES] } },
      _count: { _all: true },
    }),
  ]);

  // Per-platform tally — seed every platform with 0 so the shape is
  // stable for the widget.
  const byPlatform: PostsByPlatform = Object.fromEntries(
    ALL_SOCIAL_PLATFORMS.map((p) => [p, 0]),
  ) as PostsByPlatform;
  for (const row of publishedTodayRows) {
    byPlatform[row.platform] += 1;
  }

  // Sum `metadata.delta` for spend updates. `metadata` is `Json?` —
  // we read it defensively and skip rows without a numeric `delta`.
  const adSpendToday = sumActivityDeltas(spentUpdatesToday);
  const adSpendYesterday = sumActivityDeltas(spentUpdatesYesterday);

  let openTotal = 0;
  let inProgress = 0;
  for (const g of openDevTaskGroups) {
    openTotal += g._count._all;
    if (g.status === 'DOING') inProgress = g._count._all;
  }

  return {
    newLeadsToday,
    newLeadsYesterday,
    adSpendToday,
    adSpendYesterday,
    postsPublishedToday: {
      total: publishedTodayRows.length,
      byPlatform,
    },
    openDevTasks: {
      total: openTotal,
      inProgress,
    },
  };
}

// ---------------------------------------------------------------------------
// Row 2 — Latest AI insights
// ---------------------------------------------------------------------------

/** Fixed scope ordering so the four cards always render left-to-right
 *  in the same sequence (SPEC.md §11.1 row 2). */
const INSIGHT_SCOPE_ORDER: readonly InsightScope[] = [
  'ads',
  'social',
  'leads',
  'overall',
];

/** The four scopes the AI Analysis module reasons about (SPEC.md §10.3). */
export type InsightScope = 'ads' | 'social' | 'leads' | 'overall';

/**
 * One slot in the {@link loadLatestInsights} return array.
 *
 * Always carries a `scope` (one of the four canonical values). When no
 * insight exists for that scope yet, every other field is `null` — the
 * widget renders a "No insight yet" placeholder card instead of hiding
 * the slot, so the row is always 4-up.
 */
export interface LatestInsightSlot {
  scope: InsightScope;
  /** `null` when this scope has no AIInsight rows yet. */
  id: string | null;
  /** `null` when this scope has no AIInsight rows yet. */
  generatedAt: Date | null;
  /** Stored verbatim from `AIInsight.trend` (`'up' | 'down' | 'flat'`). */
  trend: string | null;
  trendPct: number | null;
  summary: string | null;
  suggestion: string | null;
}

/**
 * Load the most recent AIInsight for each of the four scopes (SPEC.md
 * §11.1 row 2 — "Latest AI insights").
 *
 * Returns exactly four entries in the canonical order
 * `['ads', 'social', 'leads', 'overall']`. When a scope has no insight
 * row yet, the entry's other fields are `null` so the widget can still
 * render a placeholder card.
 *
 * Fires four `findFirst` queries in parallel — one per scope, sorted
 * by `generatedAt desc`. This is cheaper than a single `findMany`
 * with a window function because each scope is independently indexed.
 *
 * @param prisma DI client.
 * @returns an array of four {@link LatestInsightSlot}s, in scope order.
 */
export async function loadLatestInsights(
  prisma: DashboardDbClient,
): Promise<LatestInsightSlot[]> {
  const rows = await Promise.all(
    INSIGHT_SCOPE_ORDER.map((scope) =>
      prisma.aIInsight.findFirst({
        where: { scope },
        orderBy: { generatedAt: 'desc' },
      }),
    ),
  );

  return INSIGHT_SCOPE_ORDER.map((scope, i) => toInsightSlot(scope, rows[i]));
}

// ---------------------------------------------------------------------------
// Row 3 — Release + Campaign timeline
// ---------------------------------------------------------------------------

/** Width of the timeline window — last 30 days back from `now`,
 *  matching SPEC.md §11.1 row 3 ("Horizontal timeline last 30 days"). */
const TIMELINE_WINDOW_DAYS = 30;

/**
 * One campaign bar on the timeline. `endDate` is `null` for open-ended
 * campaigns (still running); the widget renders those as bars that
 * extend to the right edge of the window.
 */
export interface TimelineCampaign {
  id: string;
  name: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  startDate: Date;
  endDate: Date | null;
  signups: number;
  spent: number;
  ownerId: string;
}

/** One release marker on the timeline. */
export interface TimelineRelease {
  id: string;
  title: string;
  releaseVersion: string | null;
  /** `'iOS' | 'Android' | 'Web'` per SPEC.md §9.4, but stored as a
   *  free-form string in `DevTask.platform`. */
  platform: string | null;
  releasedAt: Date;
}

export interface TimelineData {
  /** Window start (inclusive), so callers don't have to recompute it. */
  windowStart: Date;
  /** Window end (inclusive) — `now` when the loader ran. */
  windowEnd: Date;
  campaigns: TimelineCampaign[];
  releases: TimelineRelease[];
}

/**
 * Load the campaign bars and release markers behind Row 3 of the
 * dashboard (SPEC.md §11.1 row 3 — "Release + Campaign Timeline").
 *
 * Window: `[startOfDay(now - 30d), now]`. A campaign appears when its
 * date range *overlaps* the window — the `startDate` falls on or
 * before `windowEnd` AND (the `endDate` falls on or after `windowStart`
 * OR the campaign is open-ended, i.e. `endDate IS NULL`). This matches
 * the "active during window" semantics used in
 * `src/lib/aggregations/ads.ts` and `src/lib/aggregations/overall.ts`.
 *
 * A release appears when its `DevTask.releasedAt` falls inside the
 * window and its `type` is `'RELEASE'`.
 *
 * Both queries dispatch in parallel. Campaigns are sorted by
 * `startDate asc` so the bars stack chronologically; releases are
 * sorted by `releasedAt asc` for the same reason.
 *
 * @param prisma DI client.
 * @returns a {@link TimelineData} ready to feed `<ReleaseCampaignTimeline>`
 *          (task 77).
 */
export async function loadTimeline(
  prisma: DashboardDbClient,
): Promise<TimelineData> {
  const now = new Date();
  const windowStart = startOfDay(subDays(now, TIMELINE_WINDOW_DAYS));
  const windowEnd = now;

  const campaignWhere: Prisma.CampaignWhereInput = {
    startDate: { lte: windowEnd },
    OR: [{ endDate: { gte: windowStart } }, { endDate: null }],
  };
  const releaseWhere: Prisma.DevTaskWhereInput = {
    type: 'RELEASE',
    releasedAt: { gte: windowStart, lte: windowEnd },
  };

  const [campaignRows, releaseRows] = await Promise.all([
    prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        name: true,
        channel: true,
        status: true,
        startDate: true,
        endDate: true,
        signups: true,
        spent: true,
        ownerId: true,
      },
    }),
    prisma.devTask.findMany({
      where: releaseWhere,
      orderBy: { releasedAt: 'asc' },
      select: {
        id: true,
        title: true,
        releaseVersion: true,
        platform: true,
        releasedAt: true,
      },
    }),
  ]);

  // `releasedAt` is nullable in the schema but our `where` filters out
  // nulls — narrow the type for the consumer.
  const releases: TimelineRelease[] = releaseRows
    .filter((r): r is typeof r & { releasedAt: Date } => r.releasedAt !== null)
    .map((r) => ({
      id: r.id,
      title: r.title,
      releaseVersion: r.releaseVersion,
      platform: r.platform,
      releasedAt: r.releasedAt,
    }));

  return {
    windowStart,
    windowEnd,
    campaigns: campaignRows,
    releases,
  };
}

// ---------------------------------------------------------------------------
// Row 4 — Follow-ups (today + overdue)
// ---------------------------------------------------------------------------

/** One row in either follow-up bucket. */
export interface FollowUpLead {
  id: string;
  name: string;
  company: string | null;
  ownerId: string | null;
  /** `null` when the lead has no owner. */
  ownerName: string | null;
  nextFollowUpAt: Date;
  status: LeadStatus;
}

export interface FollowUpBuckets {
  todaysFollowUps: FollowUpLead[];
  overdueFollowUps: FollowUpLead[];
}

/** Statuses that "close" a lead — they don't need follow-ups even if
 *  `nextFollowUpAt` is set. */
const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ['CONVERTED', 'LOST'];

/** Cap on rows per bucket (SPEC.md §11.1 row 4 — "Today's follow-ups"
 *  list & "Overdue follow-ups" list). The widget surfaces the top
 *  matches, not an exhaustive table. */
const FOLLOW_UP_LIMIT = 50;

/**
 * Load the two follow-up buckets behind Row 4 of the dashboard
 * (SPEC.md §11.1 row 4 — "Today's follow-ups" + "Overdue follow-ups").
 *
 *   - `todaysFollowUps`  — leads whose `nextFollowUpAt` falls in the
 *                          interval `[startOfToday, startOfTomorrow)`,
 *                          excluding CONVERTED/LOST leads.
 *   - `overdueFollowUps` — leads whose `nextFollowUpAt` is strictly
 *                          before `startOfToday`, same exclusion.
 *
 * Both buckets are sorted by `nextFollowUpAt asc` (oldest follow-up
 * first in the overdue list, earliest-in-day first in today's list)
 * and capped at {@link FOLLOW_UP_LIMIT} rows.
 *
 * The owner relation is included via Prisma's `include` so the widget
 * can render the owner's name without a second round-trip; the result
 * is reshaped into a flat {@link FollowUpLead} so the widget needn't
 * know about the relation.
 *
 * @param prisma DI client.
 * @returns a {@link FollowUpBuckets} ready to feed `<QuickActions>`
 *          (task 78).
 */
export async function loadFollowUps(
  prisma: DashboardDbClient,
): Promise<FollowUpBuckets> {
  const now = new Date();
  const startOfToday = startOfDay(now);
  const startOfTomorrow = startOfDay(subDays(now, -1));

  const baseWhere: Prisma.LeadWhereInput = {
    status: { notIn: [...CLOSED_LEAD_STATUSES] },
  };

  const [todayRows, overdueRows] = await Promise.all([
    prisma.lead.findMany({
      where: {
        ...baseWhere,
        nextFollowUpAt: { gte: startOfToday, lt: startOfTomorrow },
      },
      orderBy: { nextFollowUpAt: 'asc' },
      take: FOLLOW_UP_LIMIT,
      include: { owner: { select: { id: true, name: true } } },
    }),
    prisma.lead.findMany({
      where: {
        ...baseWhere,
        nextFollowUpAt: { lt: startOfToday },
      },
      orderBy: { nextFollowUpAt: 'asc' },
      take: FOLLOW_UP_LIMIT,
      include: { owner: { select: { id: true, name: true } } },
    }),
  ]);

  return {
    todaysFollowUps: todayRows.map(toFollowUpLead),
    overdueFollowUps: overdueRows.map(toFollowUpLead),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Sum the `metadata.delta` field across a list of `campaign.spent_updated`
 * activity rows. Defensive against rows whose `metadata` is missing,
 * non-object, or carries a non-numeric `delta` — those rows contribute 0.
 */
function sumActivityDeltas(
  rows: readonly { metadata: Prisma.JsonValue | null }[],
): number {
  let total = 0;
  for (const row of rows) {
    const meta = row.metadata;
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const delta = (meta as { delta?: unknown }).delta;
      if (typeof delta === 'number' && Number.isFinite(delta)) {
        total += delta;
      }
    }
  }
  return total;
}

/**
 * Build a {@link LatestInsightSlot} from the `findFirst` result for one
 * scope. When `row` is `null` (no insights for that scope yet), every
 * field except `scope` is `null`.
 */
function toInsightSlot(
  scope: InsightScope,
  row: AIInsight | null,
): LatestInsightSlot {
  if (row === null) {
    return {
      scope,
      id: null,
      generatedAt: null,
      trend: null,
      trendPct: null,
      summary: null,
      suggestion: null,
    };
  }
  return {
    scope,
    id: row.id,
    generatedAt: row.generatedAt,
    trend: row.trend,
    trendPct: row.trendPct,
    summary: row.summary,
    suggestion: row.suggestion,
  };
}

/**
 * Reshape a `findMany` row (with the `owner` relation included) into
 * the flat {@link FollowUpLead} shape the widget consumes. Narrows the
 * `nextFollowUpAt` field from `Date | null` to `Date` — the queries
 * that produce these rows always filter on `nextFollowUpAt`, so the
 * value is non-null in practice.
 */
function toFollowUpLead(row: {
  id: string;
  name: string;
  company: string | null;
  ownerId: string | null;
  nextFollowUpAt: Date | null;
  status: LeadStatus;
  owner: { id: string; name: string } | null;
}): FollowUpLead {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    ownerId: row.ownerId,
    ownerName: row.owner?.name ?? null,
    // `nextFollowUpAt` is filtered to a non-null range upstream; fall
    // back to `new Date(0)` as a defensive guard so the type narrows.
    nextFollowUpAt: row.nextFollowUpAt ?? new Date(0),
    status: row.status,
  };
}
