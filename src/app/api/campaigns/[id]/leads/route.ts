/**
 * `GET /api/campaigns/[id]/leads` — auto-linked leads for a campaign
 * (SPEC.md §7.2.3, §7.3).
 *
 * Returns the leads whose `utmCampaign` matches the campaign's own
 * `utmCampaign` value — that's the SPEC.md §7.2.3 contract:
 *
 *   "Auto-link leads via UTM: leads with matching `utmCampaign` show
 *    under campaign"
 *
 * Edge case (SPEC.md §3): `Campaign.utmCampaign` is `unique` but
 * nullable, and `Lead.utmCampaign` is also nullable. SQL treats
 * `null = null` as `null` (not true), so a campaign without a UTM
 * tag would technically join on "no leads" already. We make this
 * explicit by short-circuiting to an empty page when the campaign's
 * `utmCampaign` is null or empty — that way the route never accidentally
 * returns leads from a different un-tagged campaign.
 *
 * RBAC (SPEC.md §2.1): authenticated users (any role) may read.
 *
 * Response shape:
 *
 *   {
 *     items: LeadPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import {
  campaignLeadsQuerySchema,
} from '@/lib/schemas/campaigns';
import {
  leadPublicProjection,
  type LeadPublic,
} from '@/lib/schemas/leads';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Next.js 14 App Router dynamic-segment context shape for `[id]`. */
interface RouteContext {
  params: { id: string };
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/[id]/leads
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    await requireSession();

    const { id } = context.params;
    const query = parseSearchParams(
      req.nextUrl.searchParams,
      campaignLeadsQuerySchema,
    );

    // Look up the campaign's UTM tag. We only need that one column —
    // if the campaign doesn't exist we 404, and if it has no UTM tag
    // we short-circuit with an empty page (see file header).
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, utmCampaign: true },
    });

    if (!campaign) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (!campaign.utmCampaign || campaign.utmCampaign.length === 0) {
      // No UTM tag → no auto-linked leads. Return an empty page
      // rather than every untagged lead in the system.
      return NextResponse.json({
        items: [] as LeadPublic[],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      });
    }

    const where = { utmCampaign: campaign.utmCampaign } as const;
    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them.
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: leadPublicProjection,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take: query.pageSize,
      }),
      prisma.lead.count({ where }),
    ]);

    return NextResponse.json({
      items: items as unknown as LeadPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
