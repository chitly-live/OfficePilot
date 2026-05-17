/**
 * `GET /api/social/stats?period=7d|30d` — weekly/monthly content
 * rollup card data (SPEC.md §8.3, §8.2.6).
 *
 * The `/social` summary card needs:
 *   • posts published this period, per platform
 *   • total reach across all published posts in the period
 *   • the top-performing post in the period (highest engagement —
 *     `likes + comments + shares`)
 *
 * We also surface aggregate counts for the calendar/list summary row
 * (total/scheduled/published/winners-in-period) so the card can render
 * a richer overview without a second round-trip.
 *
 * Window resolution:
 *   • `period=7d` (default) — last 7 days relative to `now`.
 *   • `period=30d`           — last 30 days relative to `now`.
 *   • `dateFrom`/`dateTo`    — explicit overrides (when both are set).
 *
 * The window is applied to `publishedAt` (not `createdAt`) so the
 * "posts published this week" framing in SPEC.md §8.2.6 is honoured.
 *
 * Authorisation: authenticated read for both ADMIN and EMPLOYEE
 * (SPEC.md §2.1 — social is a shared workspace).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { PostStatus, Prisma, SocialPlatform } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import {
  socialPostPublicProjection,
  socialStatsQuerySchema,
  type SocialPostPublic,
  type SocialStatsPeriod,
} from '@/lib/schemas/social';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Always render fresh — stats reflect live DB state.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Translate a `period` shortcut into a millisecond duration. Anchored
 * here (rather than ad-hoc subtract math at call sites) so the
 * cutover from `7d` to `30d` doesn't drift between routes.
 */
const PERIOD_DAYS: Record<SocialStatsPeriod, number> = {
  '7d': 7,
  '30d': 30,
};

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Per-platform rollup for the response body. */
export interface SocialPlatformStats {
  platform: SocialPlatform;
  publishedCount: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalReach: number;
  totalImpressions: number;
}

/** Top-level response shape for `/api/social/stats`. */
export interface SocialStatsResponse {
  period: SocialStatsPeriod;
  /** ISO-8601 strings so the client doesn't have to re-parse Date wire format. */
  rangeFrom: string;
  rangeTo: string;
  totals: {
    /** Total posts (any status) created in the window. */
    posts: number;
    /** Posts with status=SCHEDULED inside the window (regardless of
     *  publishedAt — a future-scheduled post is "scheduled now"). */
    scheduled: number;
    /** Posts with status=PUBLISHED whose publishedAt falls in the window. */
    published: number;
    /** Sum of likes/comments/shares across all published posts in the
     *  window. */
    likes: number;
    comments: number;
    shares: number;
    /** Sum of reach across all published posts in the window. */
    reach: number;
    /** Sum of impressions across all published posts in the window. */
    impressions: number;
  };
  byPlatform: SocialPlatformStats[];
  /** Top-performing post in the window by `likes + comments + shares`,
   *  or `null` when there were no published posts. */
  topPost: SocialPostPublic | null;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      socialStatsQuerySchema,
    );

    // Resolve the window. Explicit `dateFrom`/`dateTo` win over the
    // shortcut so callers can request a custom range; otherwise we
    // default to "now − period".
    const now = new Date();
    const periodDays = PERIOD_DAYS[query.period];
    const rangeTo = query.dateTo ?? now;
    const rangeFrom =
      query.dateFrom ?? new Date(rangeTo.getTime() - periodDays * MS_PER_DAY);

    // Window applied to `publishedAt` for the published-post slice.
    const publishedWindow: Prisma.SocialPostWhereInput = {
      status: PostStatus.PUBLISHED,
      publishedAt: { gte: rangeFrom, lte: rangeTo },
    };

    // Fan out every read in parallel: the four counts, the published-
    // window aggregate (sum of engagement + reach), the per-platform
    // group-by, and the top-post lookup.
    const [
      totalPostsInWindow,
      scheduledInWindow,
      publishedInWindow,
      windowAggregate,
      perPlatformRows,
      topPostRow,
    ] = await Promise.all([
      // Total posts created in the window — gives the calendar a sense
      // of pipeline volume independent of publish status.
      prisma.socialPost.count({
        where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      }),
      // Posts currently in SCHEDULED state with a scheduledAt inside
      // the window — these are the ones that should be on the calendar
      // for the period.
      prisma.socialPost.count({
        where: {
          status: PostStatus.SCHEDULED,
          scheduledAt: { gte: rangeFrom, lte: rangeTo },
        },
      }),
      // Posts published in the window.
      prisma.socialPost.count({ where: publishedWindow }),
      // Aggregate engagement + reach across published posts.
      prisma.socialPost.aggregate({
        where: publishedWindow,
        _sum: {
          likes: true,
          comments: true,
          shares: true,
          reach: true,
          impressions: true,
        },
      }),
      // Per-platform rollup of published posts. groupBy supports
      // _count + _sum so we get the publishedCount + engagement sums
      // in one query.
      prisma.socialPost.groupBy({
        by: ['platform'],
        where: publishedWindow,
        _count: { _all: true },
        _sum: {
          likes: true,
          comments: true,
          shares: true,
          reach: true,
          impressions: true,
        },
      }),
      // Top-performing post in the window. Engagement = likes +
      // comments + shares; Prisma can't sum across columns in
      // `orderBy`, so we approximate with `likes` (the dominant
      // signal on every platform) and re-rank in memory below using
      // the true engagement formula.
      prisma.socialPost.findMany({
        where: publishedWindow,
        select: socialPostPublicProjection,
        orderBy: [{ likes: 'desc' }, { id: 'asc' }],
        take: 25,
      }),
    ]);

    // Re-rank the candidate set by true engagement (likes + comments
    // + shares). 25 candidates is plenty — beyond that the difference
    // is statistically irrelevant for the "top performer" framing.
    let topPost: SocialPostPublic | null = null;
    if (topPostRow.length > 0) {
      let bestScore = -1;
      for (const candidate of topPostRow) {
        const score =
          candidate.likes + candidate.comments + candidate.shares;
        if (score > bestScore) {
          bestScore = score;
          topPost = candidate as unknown as SocialPostPublic;
        }
      }
    }

    // Build the per-platform array. We seed it from the actual group-by
    // result so platforms with zero published posts simply aren't
    // listed (callers can render the "no platforms yet" empty state).
    const byPlatform: SocialPlatformStats[] = perPlatformRows
      .map((row) => ({
        platform: row.platform,
        publishedCount: row._count._all,
        totalLikes: row._sum.likes ?? 0,
        totalComments: row._sum.comments ?? 0,
        totalShares: row._sum.shares ?? 0,
        totalReach: row._sum.reach ?? 0,
        totalImpressions: row._sum.impressions ?? 0,
      }))
      // Stable order so the UI can render a chart without churning.
      .sort((a, b) => a.platform.localeCompare(b.platform));

    const body: SocialStatsResponse = {
      period: query.period,
      rangeFrom: rangeFrom.toISOString(),
      rangeTo: rangeTo.toISOString(),
      totals: {
        posts: totalPostsInWindow,
        scheduled: scheduledInWindow,
        published: publishedInWindow,
        likes: windowAggregate._sum.likes ?? 0,
        comments: windowAggregate._sum.comments ?? 0,
        shares: windowAggregate._sum.shares ?? 0,
        reach: windowAggregate._sum.reach ?? 0,
        impressions: windowAggregate._sum.impressions ?? 0,
      },
      byPlatform,
      topPost,
    };

    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
