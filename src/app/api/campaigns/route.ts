/**
 * `GET /api/campaigns` and `POST /api/campaigns` — campaigns collection
 * endpoints.
 *
 * SPEC.md §7.3:
 *
 *   GET  /api/campaigns  → filtered, paginated list (default 50/page,
 *                          max 100).
 *   POST /api/campaigns  → create a campaign; creation is logged to
 *                          ActivityLog as `campaign.created`.
 *
 * RBAC (SPEC.md §2.1, §7):
 *   • Both ADMIN and EMPLOYEE can READ every campaign — campaigns are
 *     a shared workspace; visibility is global. The middleware in
 *     `src/middleware.ts` enforces authentication for `/api/campaigns`,
 *     so anonymous traffic is already 401.
 *   • Both ADMIN and EMPLOYEE can CREATE campaigns. The creator is
 *     auto-assigned as owner unless the caller specifies otherwise:
 *       - ADMIN may set `ownerId` to anyone.
 *       - EMPLOYEE may only set `ownerId` to themselves; setting it to
 *         another user is 403 (parallels the leads behaviour in
 *         SPEC.md §6.4 "auto-assign to creator unless admin specifies").
 *
 * Response shape for GET:
 *
 *   {
 *     items: CampaignPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Response shape for POST: a single `CampaignPublic` (with embedded
 * `owner`) per `campaignPublicProjection`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { PermissionError } from '@/lib/permissions';
import {
  campaignCreateSchema,
  campaignListQuerySchema,
  campaignPublicProjection,
  type CampaignPublic,
  type CampaignSortKey,
} from '@/lib/schemas/campaigns';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Sort key mapping
// ---------------------------------------------------------------------------

/**
 * Map the friendly `sortBy` query keys to the actual `Campaign`
 * columns. Keeping the public API stable against future Prisma
 * renames is the whole point of this indirection.
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

// ---------------------------------------------------------------------------
// GET /api/campaigns — paginated list
// ---------------------------------------------------------------------------

/**
 * List campaigns, filterable by every dimension on the `/marketing`
 * page (SPEC.md §7.1): status, channel, owner, free-text name search,
 * start-date range. Pagination via `page` + `pageSize` (default 50,
 * max 100 per task 40 schema).
 *
 * Both ADMIN and EMPLOYEE see the same set of campaigns — there is no
 * per-user filter. Employees still need the global view because they
 * collaborate on creative + spend updates that other people created.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      campaignListQuerySchema,
    );

    // Build the Prisma `where` from whichever filters were supplied.
    // Every branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
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
      // Postgres native `ILIKE` via Prisma `mode: 'insensitive'`. SPEC.md
      // §7.1 only mentions name-based search on the marketing list.
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
    const orderBy: Prisma.CampaignOrderByWithRelationInput[] = [
      { [sortColumn]: query.sortDir } as Prisma.CampaignOrderByWithRelationInput,
      // Tie-breaker on `id` so the same `where`/`orderBy` always
      // produces the same page boundaries (important for paginated UIs
      // that re-fetch on filter changes).
      { id: 'asc' },
    ];

    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them, so a single
    // round-trip via `Promise.all` is the right call.
    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        select: campaignPublicProjection,
        orderBy,
        skip,
        take: query.pageSize,
      }),
      prisma.campaign.count({ where }),
    ]);

    return NextResponse.json({
      items: items as unknown as CampaignPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/campaigns — create
// ---------------------------------------------------------------------------

/**
 * Create a new campaign. Authenticated users (any role) may call this.
 *
 * Flow:
 *   1. Validate body with `campaignCreateSchema` (asserts startDate,
 *      budget > 0, optional endDate ≥ startDate, etc.).
 *   2. Resolve `ownerId`:
 *        • If body.ownerId is set, use it (subject to RBAC check below).
 *        • Otherwise default to `session.userId`.
 *   3. RBAC: EMPLOYEEs may only assign new campaigns to themselves
 *      (parallels SPEC.md §6.4 for leads). ADMINs may assign to anyone.
 *   4. Insert via Prisma. `Campaign.utmCampaign` is `@unique`; if the
 *      caller passes a colliding value, Prisma throws P2002 which the
 *      shared `errorResponse` helper translates into a 409 with the
 *      offending column in `target`.
 *   5. Best-effort `campaign.created` activity log — failures are
 *      swallowed so a missing audit row never tanks a successful write.
 *   6. Return the new campaign via `campaignPublicProjection` (owner
 *      embedded).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const input = await parseJsonBody(req, campaignCreateSchema);

    // Default ownership to the creator unless explicitly set. Empty
    // string would be a bug in the schema — not handled here.
    const resolvedOwnerId = input.ownerId ?? session.userId;

    // RBAC: employees may not assign new campaigns to other people.
    if (session.role === 'EMPLOYEE' && resolvedOwnerId !== session.userId) {
      throw new PermissionError(
        'write',
        'campaign',
        'Employees can only assign new campaigns to themselves',
      );
    }

    const campaign = await prisma.campaign.create({
      data: {
        name: input.name,
        channel: input.channel,
        status: input.status,
        startDate: input.startDate,
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        budget: input.budget,
        spent: input.spent,
        impressions: input.impressions,
        clicks: input.clicks,
        signups: input.signups,
        conversions: input.conversions,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
        ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium } : {}),
        ...(input.utmCampaign !== undefined
          ? { utmCampaign: input.utmCampaign }
          : {}),
        ownerId: resolvedOwnerId,
      },
      select: campaignPublicProjection,
    });

    // Best-effort audit log. `logActivity` propagates errors by design
    // (see `src/lib/activity.ts`), so wrap it here to keep the route's
    // happy path resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.CAMPAIGN_CREATED,
        entityType: 'campaign',
        entityId: campaign.id,
        metadata: {
          entityName: campaign.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/campaigns] activity log failed', logErr);
    }

    return NextResponse.json(campaign as unknown as CampaignPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
