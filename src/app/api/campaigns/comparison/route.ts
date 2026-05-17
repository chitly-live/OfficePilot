/**
 * `GET /api/campaigns/comparison` — channel comparison rollup
 * (SPEC.md §7.2.6, §7.3).
 *
 * Aggregates campaign performance by `CampaignChannel` inside a
 * caller-supplied `[dateFrom, dateTo]` window. The result powers the
 * "channel comparison" bar chart on `/marketing` (SPEC.md §7.2.6: bar
 * chart of spend vs signups vs CAC by channel for the last 30 days).
 *
 * Per-channel aggregates (only channels with at least one campaign in
 * the window appear):
 *
 *   • `campaignCount`     — number of campaigns whose `startDate` falls
 *                            inside the window.
 *   • `totalSpent`        — sum of `Campaign.spent` for those campaigns.
 *   • `totalLeads`        — count of `Lead` rows whose `utmCampaign`
 *                            matches one of the channel's campaign UTM
 *                            tags AND whose `createdAt` falls inside
 *                            the window.
 *   • `totalConversions`  — same as `totalLeads` but restricted to
 *                            `status = 'CONVERTED'`. We use
 *                            conversions counted on the Lead side (not
 *                            the `Campaign.conversions` counter) so the
 *                            number stays consistent with what the
 *                            campaign-detail page surfaces via the
 *                            UTM-linked leads list.
 *   • `cac`               — `totalSpent / totalConversions`, or `null`
 *                            when conversions is 0 (CAC is undefined
 *                            without a denominator).
 *   • `cpl`               — `totalSpent / totalLeads`, or `null` when
 *                            leads is 0.
 *   • `conversionRate`    — `totalConversions / totalLeads`, or `null`
 *                            when leads is 0.
 *
 * Filtering: `?channel=META_ADS` narrows the rollup to a single channel
 * for drilldown views.
 *
 * RBAC (SPEC.md §2.1): authenticated users (any role) may read.
 *
 * Response shape:
 *
 *   {
 *     channels: [
 *       {
 *         channel: CampaignChannel,
 *         campaignCount: number,
 *         totalSpent: number,
 *         totalLeads: number,
 *         totalConversions: number,
 *         cac: number | null,
 *         cpl: number | null,
 *         conversionRate: number | null
 *       },
 *       ...
 *     ]
 *   }
 *
 * Implementation note: we do this in TypeScript with two
 * Prisma `groupBy` queries (one over Campaign by channel, one over
 * Lead by utmCampaign) plus a small in-memory join, rather than a
 * single `$queryRaw`. That's simpler to maintain, friendlier to
 * Prisma's connection pool (no raw SQL injection surface), and the
 * data volume in v1 is tiny (10s of campaigns × 100s of leads).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { CampaignChannel, LeadStatus, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import { campaignComparisonQuerySchema } from '@/lib/schemas/campaigns';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface ChannelComparison {
  channel: CampaignChannel;
  campaignCount: number;
  totalSpent: number;
  totalLeads: number;
  totalConversions: number;
  /** null when totalConversions === 0. */
  cac: number | null;
  /** null when totalLeads === 0. */
  cpl: number | null;
  /** null when totalLeads === 0. */
  conversionRate: number | null;
}

interface ComparisonResponse {
  channels: ChannelComparison[];
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/comparison
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      campaignComparisonQuerySchema,
    );

    // 1. Pull every campaign whose `startDate` is inside the window
    //    (and matches the optional channel filter). We need each
    //    campaign's `channel`, `utmCampaign`, and `spent` to drive the
    //    rollup — `groupBy` alone wouldn't give us the `utmCampaign`
    //    list per channel, so we hand-roll the aggregation.
    const campaignWhere: Prisma.CampaignWhereInput = {
      startDate: { gte: query.dateFrom, lte: query.dateTo },
    };
    if (query.channel !== undefined) {
      campaignWhere.channel = query.channel;
    }

    const campaigns = await prisma.campaign.findMany({
      where: campaignWhere,
      select: {
        channel: true,
        utmCampaign: true,
        spent: true,
      },
    });

    if (campaigns.length === 0) {
      // Empty window → empty result (channels[]). Don't fabricate
      // zero rows for every enum value — SPEC.md §7.2.6 only shows
      // channels that actually ran in the window.
      const empty: ComparisonResponse = { channels: [] };
      return NextResponse.json(empty);
    }

    // Group campaigns by channel in-memory. Track:
    //   - campaignCount
    //   - totalSpent
    //   - the set of utmCampaign tags belonging to that channel
    //     (used to count leads/conversions on the Lead side).
    const byChannel = new Map<
      CampaignChannel,
      {
        campaignCount: number;
        totalSpent: number;
        utmTags: Set<string>;
      }
    >();

    for (const c of campaigns) {
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

    // 2. Pull lead counts per `utmCampaign` inside the window. We do
    //    a single `groupBy` over leads whose `utmCampaign` is one of
    //    the union of all channels' tags; that's one round-trip
    //    instead of N (one per channel).
    const allUtmTags = Array.from(
      new Set(
        campaigns
          .map((c) => c.utmCampaign)
          .filter((t): t is string => !!t && t.length > 0),
      ),
    );

    // If no campaign in the window has a UTM tag, every channel's
    // lead/conversion count is 0 and we can skip the lead query.
    const leadsPerTag = new Map<string, number>();
    const conversionsPerTag = new Map<string, number>();

    if (allUtmTags.length > 0) {
      // Both groupings share the same `utmCampaign IN (...)` filter +
      // the date window on `Lead.createdAt`. Run them in parallel.
      const leadWhereBase: Prisma.LeadWhereInput = {
        utmCampaign: { in: allUtmTags },
        createdAt: { gte: query.dateFrom, lte: query.dateTo },
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
        if (row.utmCampaign) {
          leadsPerTag.set(row.utmCampaign, row._count._all);
        }
      }
      for (const row of conversionGroups) {
        if (row.utmCampaign) {
          conversionsPerTag.set(row.utmCampaign, row._count._all);
        }
      }
    }

    // 3. Stitch the two sides together. Sum lead/conversion counts
    //    across every UTM tag in the channel's bucket.
    const channels: ChannelComparison[] = [];
    for (const [channel, bucket] of byChannel) {
      let totalLeads = 0;
      let totalConversions = 0;
      for (const tag of bucket.utmTags) {
        totalLeads += leadsPerTag.get(tag) ?? 0;
        totalConversions += conversionsPerTag.get(tag) ?? 0;
      }

      const cac =
        totalConversions === 0 ? null : bucket.totalSpent / totalConversions;
      const cpl = totalLeads === 0 ? null : bucket.totalSpent / totalLeads;
      const conversionRate =
        totalLeads === 0 ? null : totalConversions / totalLeads;

      channels.push({
        channel,
        campaignCount: bucket.campaignCount,
        totalSpent: bucket.totalSpent,
        totalLeads,
        totalConversions,
        cac,
        cpl,
        conversionRate,
      });
    }

    // Stable, predictable ordering — alphabetic on the enum string so
    // the chart legend doesn't reshuffle between calls.
    channels.sort((a, b) => a.channel.localeCompare(b.channel));

    const response: ComparisonResponse = { channels };
    return NextResponse.json(response);
  } catch (err) {
    return errorResponse(err);
  }
}
