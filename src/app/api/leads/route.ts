/**
 * `GET /api/leads` and `POST /api/leads` — leads collection endpoints.
 *
 * SPEC.md §6.3:
 *
 *   GET  /api/leads  → filtered, paginated list (default 50/page, max 200).
 *   POST /api/leads  → create a lead; status changes (and creation) are
 *                      logged to ActivityLog.
 *
 * RBAC (SPEC.md §2.1, §6.4):
 *   • Both ADMIN and EMPLOYEE can READ every lead — leads are a shared
 *     pipeline; visibility is global ("read all"). The middleware in
 *     `src/middleware.ts` enforces authentication for `/api/leads`, so
 *     anonymous traffic is already 401.
 *   • Both ADMIN and EMPLOYEE can CREATE leads. The creator is auto-
 *     assigned as owner unless the caller specifies otherwise:
 *       - ADMIN may set `ownerId` to anyone.
 *       - EMPLOYEE may only set `ownerId` to themselves; setting it to
 *         another user is 403 (SPEC.md §6.4 "auto-assign to creator
 *         unless admin specifies").
 *
 * Response shape for GET:
 *
 *   {
 *     items: LeadPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Response shape for POST: a single `LeadPublic` (with embedded
 * `owner`) per `leadPublicProjection`.
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
  leadCreateSchema,
  leadListQuerySchema,
  leadPublicProjection,
  type LeadPublic,
  type LeadSortKey,
} from '@/lib/schemas/leads';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Sort key mapping
// ---------------------------------------------------------------------------

/**
 * Map the friendly `sortBy` query keys to the actual `Lead` columns.
 * Keeping the public API stable against future Prisma renames is the
 * whole point of this indirection.
 */
const SORT_COLUMN_BY_KEY: Record<LeadSortKey, keyof Prisma.LeadOrderByWithRelationInput> = {
  created: 'createdAt',
  updated: 'updatedAt',
  nextFollowUp: 'nextFollowUpAt',
  value: 'value',
};

// ---------------------------------------------------------------------------
// GET /api/leads — paginated list
// ---------------------------------------------------------------------------

/**
 * List leads, filterable by every dimension on the `/leads` page (SPEC.md
 * §6.1): status, source, priority, owner, free-text search, single tag,
 * created-at range. Pagination via `page` + `pageSize` (default 50,
 * max 200 per SPEC.md §6.3 + design.md "Performance Considerations").
 *
 * Both ADMIN and EMPLOYEE see the same set of leads — there is no
 * per-user filter. Employees still need the global view because they
 * collaborate on follow-ups and triage that other people created.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(req.nextUrl.searchParams, leadListQuerySchema);

    // Build the Prisma `where` from whichever filters were supplied.
    // Every branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
    const where: Prisma.LeadWhereInput = {};

    if (query.status && query.status.length > 0) {
      where.status = { in: query.status };
    }
    if (query.source && query.source.length > 0) {
      where.source = { in: query.source };
    }
    if (query.priority && query.priority.length > 0) {
      where.priority = { in: query.priority };
    }
    if (query.ownerId !== undefined) {
      where.ownerId = query.ownerId;
    }
    if (query.tag !== undefined) {
      // Prisma `has` performs `tags @> ARRAY[$1]` — index-friendly when
      // the column has a GIN index, which is fine for our v1 volume.
      where.tags = { has: query.tag };
    }
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      where.createdAt = {
        ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
        ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
      };
    }
    if (query.search) {
      // Postgres native `ILIKE` via Prisma `mode: 'insensitive'`. We
      // search across the four customer-identifying columns so an
      // operator can paste in "Acme", "+91…", or "jane@" and find a
      // hit. Phone and email are stored normalized but `insensitive`
      // mode tolerates either case anyway.
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
        { company: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = [
      { [sortColumn]: query.sortDir } as Prisma.LeadOrderByWithRelationInput,
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
      prisma.lead.findMany({
        where,
        select: leadPublicProjection,
        orderBy,
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

// ---------------------------------------------------------------------------
// POST /api/leads — create
// ---------------------------------------------------------------------------

/**
 * Create a new lead. Authenticated users (any role) may call this.
 *
 * Flow:
 *   1. Validate body with `leadCreateSchema` (asserts phone||email,
 *      lower-cases email, etc.).
 *   2. Resolve `ownerId`:
 *        • If body.ownerId is set, use it (subject to RBAC check below).
 *        • Otherwise default to `session.userId`.
 *   3. RBAC: EMPLOYEEs may only assign leads to themselves on creation
 *      (SPEC.md §6.4). ADMINs may assign to anyone. A mismatch → 403.
 *   4. Insert via Prisma with `createdById = session.userId`.
 *   5. Best-effort `lead.created` activity log — failures are swallowed
 *      so a missing audit row never tanks a successful write.
 *   6. Return the new lead via `leadPublicProjection` (owner embedded).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const input = await parseJsonBody(req, leadCreateSchema);

    // Default ownership to the creator unless explicitly set. Empty
    // string would be a bug in the schema — not handled here.
    const resolvedOwnerId = input.ownerId ?? session.userId;

    // RBAC: employees may not assign new leads to other people.
    if (session.role === 'EMPLOYEE' && resolvedOwnerId !== session.userId) {
      throw new PermissionError(
        'write',
        'lead',
        'Employees can only assign new leads to themselves',
      );
    }

    const lead = await prisma.lead.create({
      data: {
        name: input.name,
        // Only include optional fields when the caller provided them so
        // Prisma applies the schema defaults (`source=MANUAL`,
        // `status=NEW`, `priority=MEDIUM`, `tags=[]`) where applicable.
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        source: input.source,
        status: input.status,
        priority: input.priority,
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
        ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium } : {}),
        ...(input.utmCampaign !== undefined ? { utmCampaign: input.utmCampaign } : {}),
        ...(input.nextFollowUpAt !== undefined
          ? { nextFollowUpAt: input.nextFollowUpAt }
          : {}),
        ownerId: resolvedOwnerId,
        createdById: session.userId,
      },
      select: leadPublicProjection,
    });

    // Best-effort audit log. `logActivity` propagates errors by design
    // (see `src/lib/activity.ts`), so wrap it here to keep the route's
    // happy path resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.LEAD_CREATED,
        entityType: 'lead',
        entityId: lead.id,
        leadId: lead.id,
        metadata: {
          entityName: lead.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/leads] activity log failed', logErr);
    }

    return NextResponse.json(lead as unknown as LeadPublic, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
