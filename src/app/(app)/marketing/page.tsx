/**
 * `/marketing` — campaign list, summary cards, and channel
 * comparison chart (SPEC §7.1, §7.2.6).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate — anyone without a session is redirected to `/login`.
 *      Both ADMIN and EMPLOYEE see the same global campaign list
 *      (SPEC §2.1: campaigns are a shared workspace).
 *   2. Summary cards — four KPIs computed for the active 30-day
 *      window:
 *        • Active campaigns count
 *        • Total spend (last 30d)
 *        • Leads from campaigns (last 30d)
 *        • Avg CAC (last 30d) = totalSpend / totalConversions
 *      The "last 30d" window is fixed (relative to `now`) — SPEC
 *      §7.1 names "MTD" but the channel comparison chart and
 *      acceptance criteria 6.7 both describe a 30-day window, so we
 *      align on that. Avg CAC is the blended CAC across all channels
 *      in the window (SPEC §7.1).
 *   3. Channel comparison chart (Task 47) — fetched server-side via
 *      Prisma using the same logic as `/api/campaigns/comparison`.
 *      Wrapped in a Card titled "Channel performance — last 30
 *      days".
 *   4. Filter bar (`MarketingFilters`) + paginated table
 *      (`CampaignsTable`) + URL-driven `Pagination`. Mirrors the
 *      Leads list pattern in `src/app/(app)/leads/page.tsx`.
 *
 * URL contract:
 *
 *   /marketing
 *     ?search=
 *     &status=DRAFT,ACTIVE                  (comma-separated multi)
 *     &channel=META_ADS,GOOGLE_ADS          (comma-separated multi)
 *     &ownerId=…
 *     &dateFrom=2026-01-01
 *     &dateTo=2026-01-31
 *     &sortBy=created                       (created · updated · …)
 *     &page=2
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Link as LinkIcon, Plus } from 'lucide-react';
import { CampaignChannel, CampaignStatus, LeadStatus, Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  CAMPAIGN_SORT_KEYS,
  campaignListQuerySchema,
  campaignPublicProjection,
  type CampaignPublic,
  type CampaignSortKey,
} from '@/lib/schemas/campaigns';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';
import { StatCard } from '@/components/shared/StatCard';

import { CampaignsTable } from './campaigns-table';
import {
  ChannelComparisonChart,
  type ChannelComparisonRow,
} from './channel-comparison-chart';
import {
  MarketingFilters,
  type OwnerOption,
} from './marketing-filters';

export const metadata = {
  title: 'Marketing',
};

// Always render fresh — the list reflects live DB state.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sort-key → Prisma column mapping. Mirrors
 * `SORT_COLUMN_BY_KEY` in `src/app/api/campaigns/route.ts` so client
 * and server agree on the column meanings.
 */
const SORT_COLUMN_BY_KEY: Record<
  CampaignSortKey,
  keyof Prisma.CampaignOrderByWithRelationInput
> = {
  created: 'createdAt',
  updated: 'updatedAt',
  startDate: 'startDate',
  budget: 'budget',
  spent: 'spent',
  conversions: 'conversions',
};

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

/**
 * Format an INR value with the Indian numbering convention. Returns
 * `—` for null/undefined/non-finite so KPI cards never show NaN.
 */
function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface MarketingPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function MarketingPage({
  searchParams,
}: MarketingPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/marketing');
  }

  // ------------------------------------------------------------------
  // 2. Parse + validate the search params with the same schema the
  //    API route uses.
  // ------------------------------------------------------------------
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // `safeParse` so an invalid query string falls back to defaults
  // rather than 500ing the page.
  const parsed = campaignListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : campaignListQuerySchema.parse({});

  // ------------------------------------------------------------------
  // 3. Build the Prisma where clause — identical to the API route.
  // ------------------------------------------------------------------
  const where: Prisma.CampaignWhereInput = {};

  if (query.status && query.status.length > 0) {
    where.status = { in: query.status };
  }
  if (query.channel && query.channel.length > 0) {
    where.channel = { in: query.channel };
  }
  if (query.ownerId !== undefined) {
    where.ownerId = query.ownerId;
  }
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    where.startDate = {
      ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
    };
  }
  if (query.search) {
    where.name = { contains: query.search, mode: 'insensitive' };
  }

  const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
  const orderBy: Prisma.CampaignOrderByWithRelationInput[] = [
    { [sortColumn]: query.sortDir } as Prisma.CampaignOrderByWithRelationInput,
    { id: 'asc' },
  ];

  const skip = (query.page - 1) * query.pageSize;

  // ------------------------------------------------------------------
  // 4. 30-day window for summary cards + channel comparison.
  //    `now` is captured once so every parallel query agrees on the
  //    same instant.
  // ------------------------------------------------------------------
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // ------------------------------------------------------------------
  // 5. Fan out every read in parallel: list, count, owner lookup,
  //    KPI summary aggregations, and the channel comparison rollup.
  // ------------------------------------------------------------------
  const [
    items,
    total,
    ownerRows,
    activeCount,
    spendAggregate,
    leadsCount,
    convertedCount,
    last30Campaigns,
  ] = await Promise.all([
    prisma.campaign.findMany({
      where,
      select: campaignPublicProjection,
      orderBy,
      skip,
      take: query.pageSize,
    }),
    prisma.campaign.count({ where }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
    // Active campaigns "right now" — status === ACTIVE. Independent
    // of the 30-day window because "currently active" is the more
    // useful signal for the summary card.
    prisma.campaign.count({ where: { status: CampaignStatus.ACTIVE } }),
    // Total spend across campaigns whose `startDate` falls inside the
    // 30-day window. We use `startDate` (not `createdAt`) to match the
    // /api/campaigns/comparison endpoint's window semantics.
    prisma.campaign.aggregate({
      where: { startDate: { gte: thirtyDaysAgo, lte: now } },
      _sum: { spent: true, conversions: true },
    }),
    // Leads attributed to any campaign (i.e. with a non-null
    // utmCampaign) in the 30-day window. Used for the "Leads from
    // campaigns" KPI.
    prisma.lead.count({
      where: {
        utmCampaign: { not: null },
        createdAt: { gte: thirtyDaysAgo, lte: now },
      },
    }),
    // Conversions in the same window — used to compute blended CAC.
    // We count converted leads attributed to a campaign rather than
    // summing `Campaign.conversions` so the number stays consistent
    // with the channel comparison chart (which counts on the Lead
    // side) and the campaign detail "linked leads" tab.
    prisma.lead.count({
      where: {
        utmCampaign: { not: null },
        status: LeadStatus.CONVERTED,
        createdAt: { gte: thirtyDaysAgo, lte: now },
      },
    }),
    // Channel comparison rollup — same query shape as
    // `/api/campaigns/comparison`. We need every campaign's
    // utmCampaign + spent + channel inside the 30-day window so we
    // can stitch in lead counts below.
    prisma.campaign.findMany({
      where: { startDate: { gte: thirtyDaysAgo, lte: now } },
      select: { channel: true, utmCampaign: true, spent: true },
    }),
  ]);

  // ------------------------------------------------------------------
  // 6. Channel comparison — group campaigns by channel in-memory and
  //    look up lead counts per UTM tag. Mirrors the implementation in
  //    `/api/campaigns/comparison`.
  // ------------------------------------------------------------------
  const byChannel = new Map<
    CampaignChannel,
    {
      campaignCount: number;
      totalSpent: number;
      utmTags: Set<string>;
    }
  >();
  for (const c of last30Campaigns) {
    let bucket = byChannel.get(c.channel);
    if (!bucket) {
      bucket = {
        campaignCount: 0,
        totalSpent: 0,
        utmTags: new Set<string>(),
      };
      byChannel.set(c.channel, bucket);
    }
    bucket.campaignCount += 1;
    bucket.totalSpent += c.spent;
    if (c.utmCampaign && c.utmCampaign.length > 0) {
      bucket.utmTags.add(c.utmCampaign);
    }
  }

  const allUtmTags = Array.from(
    new Set(
      last30Campaigns
        .map((c) => c.utmCampaign)
        .filter((t): t is string => !!t && t.length > 0),
    ),
  );

  const leadsPerTag = new Map<string, number>();
  const conversionsPerTag = new Map<string, number>();
  if (allUtmTags.length > 0) {
    const leadWhereBase: Prisma.LeadWhereInput = {
      utmCampaign: { in: allUtmTags },
      createdAt: { gte: thirtyDaysAgo, lte: now },
    };
    const [leadGroups, conversionGroups] = await Promise.all([
      prisma.lead.groupBy({
        by: ['utmCampaign'],
        where: leadWhereBase,
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ['utmCampaign'],
        where: { ...leadWhereBase, status: LeadStatus.CONVERTED },
        _count: { _all: true },
      }),
    ]);
    for (const row of leadGroups) {
      if (row.utmCampaign) leadsPerTag.set(row.utmCampaign, row._count._all);
    }
    for (const row of conversionGroups) {
      if (row.utmCampaign) {
        conversionsPerTag.set(row.utmCampaign, row._count._all);
      }
    }
  }

  const channelRows: ChannelComparisonRow[] = [];
  for (const [channel, bucket] of byChannel) {
    let tLeads = 0;
    let tConversions = 0;
    for (const tag of bucket.utmTags) {
      tLeads += leadsPerTag.get(tag) ?? 0;
      tConversions += conversionsPerTag.get(tag) ?? 0;
    }
    channelRows.push({
      channel,
      campaignCount: bucket.campaignCount,
      totalSpent: bucket.totalSpent,
      totalLeads: tLeads,
      totalConversions: tConversions,
      cac: tConversions === 0 ? null : bucket.totalSpent / tConversions,
      cpl: tLeads === 0 ? null : bucket.totalSpent / tLeads,
      conversionRate: tLeads === 0 ? null : tConversions / tLeads,
    });
  }
  channelRows.sort((a, b) => a.channel.localeCompare(b.channel));

  // ------------------------------------------------------------------
  // 7. KPI summary cards.
  // ------------------------------------------------------------------
  const totalSpent30d = spendAggregate._sum.spent ?? 0;
  const totalConversions30d = channelRows.reduce(
    (sum, r) => sum + r.totalConversions,
    0,
  );
  // Blended CAC = total spend / total conversions in the window.
  // `null` when there are no conversions yet (CAC is undefined).
  const avgCac =
    totalConversions30d === 0
      ? null
      : totalSpent30d / totalConversions30d;

  // ------------------------------------------------------------------
  // 8. Filter-bar feeders.
  // ------------------------------------------------------------------
  const ownerOptions: OwnerOption[] = ownerRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  const defaultDateFrom = query.dateFrom
    ? query.dateFrom.toISOString().slice(0, 10)
    : '';
  const defaultDateTo = query.dateTo
    ? query.dateTo.toISOString().slice(0, 10)
    : '';
  // `query.sortBy` is typed as `CampaignSortKey` already; assert via
  // the union to keep the filter prop types tight.
  const sortByValue: CampaignSortKey =
    (CAMPAIGN_SORT_KEYS as readonly string[]).includes(query.sortBy)
      ? (query.sortBy as CampaignSortKey)
      : 'created';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing"
        subtitle="Campaigns, spend, and channel performance — attribute leads back to ads."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/marketing/utm">
                <LinkIcon className="h-4 w-4" aria-hidden="true" />
                <span>UTM builder</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/marketing/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>New campaign</span>
              </Link>
            </Button>
          </div>
        }
      />

      {/* Summary cards (4 KPIs). */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active campaigns"
          value={activeCount.toLocaleString('en-IN')}
        />
        <StatCard
          label="Total spent (last 30d)"
          value={formatInr(totalSpent30d)}
        />
        <StatCard
          label="Leads from campaigns (last 30d)"
          value={leadsCount.toLocaleString('en-IN')}
          delta={
            convertedCount > 0
              ? {
                  direction: 'up',
                  label: `${convertedCount.toLocaleString('en-IN')} converted`,
                }
              : undefined
          }
        />
        <StatCard
          label="Avg CAC (last 30d)"
          value={avgCac === null ? '—' : formatInr(avgCac)}
          // Lower CAC is better — invert color semantics so a downward
          // trend reads as positive.
          invertColor
        />
      </div>

      {/* Channel comparison (Task 47). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Channel performance — last 30 days
          </CardTitle>
          <CardDescription>
            Spend versus leads attributed via UTM tags, grouped by
            channel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChannelComparisonChart rows={channelRows} />
        </CardContent>
      </Card>

      <MarketingFilters
        defaultSearch={query.search ?? ''}
        defaultStatus={query.status ?? []}
        defaultChannel={query.channel ?? []}
        defaultOwnerId={query.ownerId ?? ''}
        defaultDateFrom={defaultDateFrom}
        defaultDateTo={defaultDateTo}
        defaultSortBy={sortByValue}
        ownerOptions={ownerOptions}
      />

      <CampaignsTable items={items as CampaignPublic[]} />
      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        basePath="/marketing"
        searchParams={{
          search: query.search,
          status:
            query.status && query.status.length > 0
              ? query.status.join(',')
              : undefined,
          channel:
            query.channel && query.channel.length > 0
              ? query.channel.join(',')
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
    </div>
  );
}
