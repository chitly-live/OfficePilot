/**
 * Social-scope metrics aggregation for AI insights (SPEC.md §10.3 — "Social scope").
 *
 * `aggregateSocial` snapshots organic-content performance over a 7-day
 * window vs. the prior 7 days:
 *
 *   - `summary`         — total posts, total reach, and average engagement
 *                         rate for the current and previous period.
 *   - `byPlatform`      — per-`SocialPlatform` slice of posts, reach, and
 *                         engagement (sum of likes + comments + shares)
 *                         for the current period.
 *   - `topPosts`        — top-3 published posts by reach (current period).
 *   - `bottomPosts`     — bottom-3 published posts by reach (current period).
 *   - `dayOfWeekPattern`— Mon..Sun → number of posts published on that
 *                         weekday during the current period (helps Claude
 *                         flag posting cadence).
 *
 * Only `PUBLISHED` posts within `[periodStart, periodEnd]` (inclusive) are
 * included. Engagement rate per post is `(likes + comments + shares) / reach`,
 * treated as `0` when reach is `0`. The summary engagement rate is the
 * arithmetic mean of per-post rates (so a tiny-reach post can't dominate
 * a viral one); when there are zero posts in the window, it is `0`.
 *
 * Captions in `topPosts`/`bottomPosts` are truncated to 100 chars (with
 * the ellipsis suffix `…` when longer) so the data block sent to Claude
 * stays compact.
 *
 * The function is dependency-injected: pass a `PrismaClient` or a
 * `Prisma.TransactionClient`. The return value is plain JSON (no `Date`
 * objects, no `BigInt`) so it can be stored verbatim in `AIInsight.rawData`.
 */

import type { Prisma, PrismaClient, SocialPlatform } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SocialDbClient = PrismaClient | Prisma.TransactionClient;

/** Day-of-week shorthand used in `dayOfWeekPattern`. Mon-first to match
 *  the SPEC's "best day to post" framing. */
export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface SocialByPlatform {
  platform: SocialPlatform;
  posts: number;
  reach: number;
  /** Sum of likes + comments + shares across the platform's posts. */
  engagement: number;
}

export interface SocialPostPick {
  id: string;
  platform: SocialPlatform;
  /** Caption truncated to 100 chars (with `…` suffix when longer). */
  caption: string;
  reach: number;
  likes: number;
  comments: number;
}

export interface SocialAggregate {
  summary: {
    totalPosts: number;
    totalPostsPrev: number;
    totalReach: number;
    totalReachPrev: number;
    /** Mean of per-post engagement rates in the current period. `0` when
     *  there are no posts. */
    engagementRate: number;
    engagementRatePrev: number;
  };
  byPlatform: SocialByPlatform[];
  topPosts: SocialPostPick[];
  bottomPosts: SocialPostPick[];
  dayOfWeekPattern: Record<Weekday, number>;
}

const CAPTION_MAX_LEN = 100;
const TOP_BOTTOM_LIMIT = 3;

const WEEKDAYS: readonly Weekday[] = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot social metrics for a 7-day window vs. the prior 7 days.
 *
 * @param prisma       any client satisfying {@link SocialDbClient} (DI).
 * @param periodStart  inclusive lower bound for the current window.
 * @param periodEnd    inclusive upper bound for the current window.
 * @param prevStart    inclusive lower bound for the previous window.
 * @param prevEnd      inclusive upper bound for the previous window.
 * @returns a JSON-serialisable {@link SocialAggregate} ready for Claude.
 */
export async function aggregateSocial(
  prisma: SocialDbClient,
  periodStart: Date,
  periodEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<SocialAggregate> {
  // Both periods need post-level data so we can compute the average
  // per-post engagement rate. Pull only the columns we need.
  const select = {
    id: true,
    platform: true,
    caption: true,
    publishedAt: true,
    likes: true,
    comments: true,
    shares: true,
    reach: true,
  } satisfies Prisma.SocialPostSelect;

  const [currentPosts, previousPosts] = await Promise.all([
    prisma.socialPost.findMany({
      where: publishedDuring(periodStart, periodEnd),
      select,
    }),
    prisma.socialPost.findMany({
      where: publishedDuring(prevStart, prevEnd),
      select,
    }),
  ]);

  const totalReach = sumBy(currentPosts, (p) => p.reach);
  const totalReachPrev = sumBy(previousPosts, (p) => p.reach);

  const byPlatform = groupByPlatform(currentPosts);
  const sortedByReach = [...currentPosts].sort((a, b) => b.reach - a.reach);
  const topPosts = sortedByReach.slice(0, TOP_BOTTOM_LIMIT).map(toPick);
  // `.slice(-N)` keeps the last N entries in descending order (e.g.
  // [reach 5, reach 3, reach 1]). One `.reverse()` flips that to
  // ascending so the lowest-reach post is first — matches the "bottom"
  // ordering the SPEC asks for.
  const bottomPosts = sortedByReach
    .slice(-TOP_BOTTOM_LIMIT)
    .reverse()
    .map(toPick);

  return {
    summary: {
      totalPosts: currentPosts.length,
      totalPostsPrev: previousPosts.length,
      totalReach,
      totalReachPrev,
      engagementRate: meanEngagementRate(currentPosts),
      engagementRatePrev: meanEngagementRate(previousPosts),
    },
    byPlatform,
    topPosts,
    bottomPosts,
    dayOfWeekPattern: dayOfWeekHistogram(currentPosts),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

function publishedDuring(start: Date, end: Date): Prisma.SocialPostWhereInput {
  return {
    status: 'PUBLISHED',
    publishedAt: { gte: start, lte: end },
  };
}

function sumBy<T>(rows: readonly T[], selector: (row: T) => number): number {
  let total = 0;
  for (const row of rows) total += selector(row);
  return total;
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

function meanEngagementRate(
  posts: readonly { likes: number; comments: number; shares: number; reach: number }[],
): number {
  if (posts.length === 0) return 0;
  let sum = 0;
  for (const p of posts) sum += postEngagementRate(p);
  return sum / posts.length;
}

function groupByPlatform(
  posts: readonly {
    platform: SocialPlatform;
    likes: number;
    comments: number;
    shares: number;
    reach: number;
  }[],
): SocialByPlatform[] {
  const acc = new Map<
    SocialPlatform,
    { posts: number; reach: number; engagement: number }
  >();
  for (const p of posts) {
    const cur = acc.get(p.platform) ?? { posts: 0, reach: 0, engagement: 0 };
    cur.posts += 1;
    cur.reach += p.reach;
    cur.engagement += p.likes + p.comments + p.shares;
    acc.set(p.platform, cur);
  }
  return [...acc.entries()]
    .map(([platform, v]) => ({ platform, ...v }))
    // Stable ordering — biggest reach first.
    .sort((a, b) => b.reach - a.reach);
}

function toPick(post: {
  id: string;
  platform: SocialPlatform;
  caption: string;
  reach: number;
  likes: number;
  comments: number;
}): SocialPostPick {
  return {
    id: post.id,
    platform: post.platform,
    caption: truncate(post.caption, CAPTION_MAX_LEN),
    reach: post.reach,
    likes: post.likes,
    comments: post.comments,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function dayOfWeekHistogram(
  posts: readonly { publishedAt: Date | null }[],
): Record<Weekday, number> {
  const histogram: Record<Weekday, number> = {
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
  };
  for (const p of posts) {
    if (!p.publishedAt) continue;
    // `getDay()` is 0 = Sunday, 6 = Saturday.
    const dow = WEEKDAYS[p.publishedAt.getDay()];
    if (dow) histogram[dow] += 1;
  }
  return histogram;
}
