/**
 * `/social` — social posts list + month-grid calendar (SPEC.md §8.1,
 * §8.2.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate — anyone without a session is redirected to `/login`.
 *      Both ADMIN and EMPLOYEE see the same global post list (SPEC.md
 *      §2.1: social is a shared workspace).
 *   2. View toggle — `?view=calendar|list`. Defaults to `calendar`
 *      (SPEC.md §8.1 lists the calendar first). The list view uses
 *      pagination; the calendar view fetches the full visible-month
 *      window so every scheduled post lands on the correct day.
 *   3. Filter bar (`SocialFilters`) — platform, status, owner, search,
 *      scheduled-date range, sort. Mirrors the marketing/leads filter
 *      UX.
 *   4. List view: `SocialPostsTable` + `Pagination`.
 *      Calendar view: `SocialPostsCalendar` (no pagination — month
 *      grid).
 *
 * URL contract:
 *
 *   /social
 *     ?view=calendar|list                  (default: calendar)
 *     &search=
 *     &platform=INSTAGRAM,FACEBOOK         (comma-separated multi)
 *     &status=DRAFT,SCHEDULED              (comma-separated multi)
 *     &ownerId=…
 *     &dateFrom=2026-01-01
 *     &dateTo=2026-01-31
 *     &sortBy=created                      (created · updated · …)
 *     &page=2                              (list view only)
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, Trophy } from 'lucide-react';
import { Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  SOCIAL_SORT_KEYS,
  socialPostListQuerySchema,
  socialPostPublicProjection,
  type SocialPostPublic,
  type SocialSortKey,
} from '@/lib/schemas/social';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';

import { SocialFilters, type OwnerOption } from './social-filters';
import { SocialPostsCalendar } from './posts-calendar';
import { SocialPostsTable } from './posts-table';
import { SocialViewToggle, type SocialView } from './view-toggle';

export const metadata = {
  title: 'Social',
};

// Always render fresh — the list reflects live DB state.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sort-key → Prisma column mapping. Mirrors `SORT_COLUMN_BY_KEY` in
 * `src/app/api/social/posts/route.ts` so client and server agree on
 * the column meanings.
 */
const SORT_COLUMN_BY_KEY: Record<
  SocialSortKey,
  keyof Prisma.SocialPostOrderByWithRelationInput
> = {
  created: 'createdAt',
  updated: 'updatedAt',
  scheduled: 'scheduledAt',
  published: 'publishedAt',
  engagement: 'likes',
};

/** Hard cap on the calendar view's row count. SPEC.md §8.4 measures
 *  performance on 100 posts; cap at 500 (≈16 posts/day for a month)
 *  so a busy account still renders without choking. */
const CALENDAR_MAX_ROWS = 500;

/**
 * Coerce Next.js's `string | string[] | undefined` searchParam shape
 * into a single string. Multi-value filters are stored as comma-joined
 * strings in the URL (matching the API's `multiEnum` parser) so we
 * don't expect arrays, but we handle them defensively.
 */
function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(',');
    return joined.length > 0 ? joined : undefined;
  }
  return raw;
}

/** Recognised values for `?view=`. */
const VIEW_VALUES: readonly SocialView[] = ['calendar', 'list'];

/**
 * Resolve the visible month window based on the search params. When
 * the user has set a `dateFrom`/`dateTo`, the calendar honours those
 * bounds (so a manual narrow window still works). Otherwise we fall
 * back to "current month ± 7 days" so the grid's prev/next-month
 * spillover cells are populated as the user navigates.
 */
function resolveCalendarRange(
  dateFrom: Date | undefined,
  dateTo: Date | undefined,
): { from: Date; to: Date } {
  if (dateFrom && dateTo) {
    return { from: dateFrom, to: dateTo };
  }
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  // Pad ±10 days so the grid's spillover cells (last week of prev
  // month + first week of next month) are populated with their real
  // posts rather than blank slots.
  const from = new Date(monthStart.getTime() - 10 * 24 * 60 * 60 * 1000);
  const to = new Date(monthEnd.getTime() + 10 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface SocialPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function SocialPage({
  searchParams,
}: SocialPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/social');
  }

  // ------------------------------------------------------------------
  // 2. View resolution.
  // ------------------------------------------------------------------
  const rawView = coerceParam(searchParams?.view);
  const view: SocialView = (VIEW_VALUES as readonly string[]).includes(
    rawView ?? '',
  )
    ? (rawView as SocialView)
    : 'calendar';

  // ------------------------------------------------------------------
  // 3. Parse + validate the search params with the same schema the
  //    API route uses.
  // ------------------------------------------------------------------
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === 'view') continue;
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // `safeParse` so an invalid query string falls back to defaults
  // rather than 500ing the page.
  const parsed = socialPostListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : socialPostListQuerySchema.parse({});

  // ------------------------------------------------------------------
  // 4. Build the Prisma where clause — identical to the API route.
  // ------------------------------------------------------------------
  const where: Prisma.SocialPostWhereInput = {};

  if (query.platform && query.platform.length > 0) {
    where.platform = { in: query.platform };
  }
  if (query.status && query.status.length > 0) {
    where.status = { in: query.status };
  }
  if (query.ownerId !== undefined) {
    where.ownerId = query.ownerId;
  }
  if (query.isWinner !== undefined) {
    where.isWinner = query.isWinner;
  }
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    where.scheduledAt = {
      ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
    };
  }
  if (query.search) {
    where.caption = { contains: query.search, mode: 'insensitive' };
  }

  const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
  const orderBy: Prisma.SocialPostOrderByWithRelationInput[] = [
    { [sortColumn]: query.sortDir } as Prisma.SocialPostOrderByWithRelationInput,
    { id: 'asc' },
  ];

  // ------------------------------------------------------------------
  // 5. Fetch the data. The list view paginates; the calendar view
  //    pulls the visible-month window (capped at CALENDAR_MAX_ROWS).
  //
  //    For the calendar we override `where.scheduledAt` to match the
  //    visible month — the user's existing `dateFrom`/`dateTo` win
  //    if set, otherwise we use the current month ±10 days. We also
  //    OR in a `publishedAt` clause so a published-but-not-scheduled
  //    post still renders on its publish day.
  // ------------------------------------------------------------------
  const skip = (query.page - 1) * query.pageSize;
  const ownerRowsPromise = prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 200,
  });

  let listItems: SocialPostPublic[] = [];
  let listTotal = 0;
  let calendarItems: SocialPostPublic[] = [];

  if (view === 'list') {
    const [items, total, ownerRows] = await Promise.all([
      prisma.socialPost.findMany({
        where,
        select: socialPostPublicProjection,
        orderBy,
        skip,
        take: query.pageSize,
      }),
      prisma.socialPost.count({ where }),
      ownerRowsPromise,
    ]);
    listItems = items as unknown as SocialPostPublic[];
    listTotal = total;

    return renderShell({
      view,
      query,
      listItems,
      listTotal,
      calendarItems: [],
      ownerOptions: ownerRows.map((u) => ({
        id: u.id,
        label: u.name?.trim() || u.email,
      })),
    });
  }

  // Calendar branch.
  const { from: calFrom, to: calTo } = resolveCalendarRange(
    query.dateFrom,
    query.dateTo,
  );
  // Compose calendar-specific where: keep all the user's filters
  // (platform/status/owner/search/isWinner) but swap the date bounds
  // for the visible month. Match posts whose `scheduledAt` OR
  // `publishedAt` falls inside the window so published-but-undated
  // (rare) posts still render.
  const calendarWhere: Prisma.SocialPostWhereInput = { ...where };
  delete calendarWhere.scheduledAt;
  calendarWhere.OR = [
    { scheduledAt: { gte: calFrom, lte: calTo } },
    { publishedAt: { gte: calFrom, lte: calTo } },
  ];

  const [calItems, ownerRows] = await Promise.all([
    prisma.socialPost.findMany({
      where: calendarWhere,
      select: socialPostPublicProjection,
      orderBy: [
        { scheduledAt: 'asc' },
        { publishedAt: 'asc' },
        { id: 'asc' },
      ],
      take: CALENDAR_MAX_ROWS,
    }),
    ownerRowsPromise,
  ]);
  calendarItems = calItems as unknown as SocialPostPublic[];

  return renderShell({
    view,
    query,
    listItems: [],
    listTotal: 0,
    calendarItems,
    ownerOptions: ownerRows.map((u) => ({
      id: u.id,
      label: u.name?.trim() || u.email,
    })),
  });
}

// ---------------------------------------------------------------------------
// Shell renderer
// ---------------------------------------------------------------------------

interface RenderShellArgs {
  view: SocialView;
  query: ReturnType<typeof socialPostListQuerySchema.parse>;
  listItems: SocialPostPublic[];
  listTotal: number;
  calendarItems: SocialPostPublic[];
  ownerOptions: OwnerOption[];
}

function renderShell({
  view,
  query,
  listItems,
  listTotal,
  calendarItems,
  ownerOptions,
}: RenderShellArgs) {
  const defaultDateFrom = query.dateFrom
    ? query.dateFrom.toISOString().slice(0, 10)
    : '';
  const defaultDateTo = query.dateTo
    ? query.dateTo.toISOString().slice(0, 10)
    : '';
  const sortByValue: SocialSortKey = (
    SOCIAL_SORT_KEYS as readonly string[]
  ).includes(query.sortBy)
    ? (query.sortBy as SocialSortKey)
    : 'created';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social"
        subtitle="Plan, log, and learn from posts across every channel."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/social/winners">
                <Trophy className="h-4 w-4" aria-hidden="true" />
                <span>Winners</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/social/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>New post</span>
              </Link>
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SocialViewToggle current={view} />
      </div>

      <SocialFilters
        defaultSearch={query.search ?? ''}
        defaultPlatform={query.platform ?? []}
        defaultStatus={query.status ?? []}
        defaultOwnerId={query.ownerId ?? ''}
        defaultDateFrom={defaultDateFrom}
        defaultDateTo={defaultDateTo}
        defaultSortBy={sortByValue}
        ownerOptions={ownerOptions}
      />

      {view === 'calendar' ? (
        <SocialPostsCalendar items={calendarItems} />
      ) : (
        <>
          <SocialPostsTable items={listItems} />
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={listTotal}
            basePath="/social"
            searchParams={{
              view: view === 'list' ? 'list' : undefined,
              search: query.search,
              platform:
                query.platform && query.platform.length > 0
                  ? query.platform.join(',')
                  : undefined,
              status:
                query.status && query.status.length > 0
                  ? query.status.join(',')
                  : undefined,
              ownerId: query.ownerId,
              dateFrom:
                query.dateFrom !== undefined
                  ? query.dateFrom.toISOString().slice(0, 10)
                  : undefined,
              dateTo:
                query.dateTo !== undefined
                  ? query.dateTo.toISOString().slice(0, 10)
                  : undefined,
              sortBy: query.sortBy !== 'created' ? query.sortBy : undefined,
              sortDir: query.sortDir !== 'desc' ? query.sortDir : undefined,
            }}
          />
        </>
      )}
    </div>
  );
}
