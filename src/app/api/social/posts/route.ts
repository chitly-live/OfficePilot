/**
 * `GET /api/social/posts` and `POST /api/social/posts` — social posts
 * collection endpoints (SPEC.md §8.3).
 *
 *   GET  /api/social/posts  → filtered, paginated list (default 50/page,
 *                              max 200 — matches the leads list).
 *   POST /api/social/posts  → create a draft / scheduled post; creation
 *                              is logged to ActivityLog as
 *                              `socialpost.created`.
 *
 * RBAC (SPEC.md §2.1, §8):
 *   • Both ADMIN and EMPLOYEE can READ every post — social is a shared
 *     workspace; visibility is global. The middleware in
 *     `src/middleware.ts` enforces authentication for `/api/social/*`,
 *     so anonymous traffic is already 401.
 *   • Both ADMIN and EMPLOYEE can CREATE posts. The creator is auto-
 *     assigned as owner unless the caller specifies otherwise:
 *       - ADMIN may set `ownerId` to anyone.
 *       - EMPLOYEE may only set `ownerId` to themselves; setting it to
 *         another user is 403 (parallels the leads behaviour in
 *         SPEC.md §6.4 and the campaigns behaviour in §7).
 *
 * Response shape for GET:
 *
 *   {
 *     items: SocialPostPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Response shape for POST: a single `SocialPostPublic` (with embedded
 * `owner`) per `socialPostPublicProjection`.
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
  socialPostCreateSchema,
  socialPostListQuerySchema,
  socialPostPublicProjection,
  type SocialPostPublic,
  type SocialSortKey,
} from '@/lib/schemas/social';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Sort key mapping
// ---------------------------------------------------------------------------

/**
 * Map the friendly `sortBy` query keys to the actual `SocialPost`
 * columns. Keeping the public API stable against future Prisma
 * renames is the whole point of this indirection.
 *
 * Note on `engagement`: Prisma's `orderBy` can't sum across columns,
 * so we approximate "engagement" as `likes` (the dominant signal on
 * every platform). A future migration could materialise a
 * `engagementScore` column if a more accurate sort is needed.
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

// ---------------------------------------------------------------------------
// GET /api/social/posts — paginated list
// ---------------------------------------------------------------------------

/**
 * List posts, filterable by every dimension on the `/social` page
 * (SPEC.md §8.1): platform, status, owner, free-text caption search,
 * scheduled-date range, isWinner. Pagination via `page` + `pageSize`
 * (default 50, max 200).
 *
 * Both ADMIN and EMPLOYEE see the same set of posts — there is no
 * per-user filter. Employees still need the global view because they
 * collaborate on creative + performance updates that other people
 * authored.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      socialPostListQuerySchema,
    );

    // Build the Prisma `where` from whichever filters were supplied.
    // Every branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
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
      // Postgres native `ILIKE` via Prisma `mode: 'insensitive'`.
      // SPEC.md §8.1 doesn't formally name a search field, but caption
      // is the only meaningful free-text column on a post.
      where.caption = { contains: query.search, mode: 'insensitive' };
    }

    const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
    const orderBy: Prisma.SocialPostOrderByWithRelationInput[] = [
      { [sortColumn]: query.sortDir } as Prisma.SocialPostOrderByWithRelationInput,
      // Tie-breaker on `id` so the same `where`/`orderBy` always
      // produces the same page boundaries (important for paginated
      // UIs that re-fetch on filter changes).
      { id: 'asc' },
    ];

    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them, so a
    // single round-trip via `Promise.all` is the right call.
    const [items, total] = await Promise.all([
      prisma.socialPost.findMany({
        where,
        select: socialPostPublicProjection,
        orderBy,
        skip,
        take: query.pageSize,
      }),
      prisma.socialPost.count({ where }),
    ]);

    return NextResponse.json({
      items: items as unknown as SocialPostPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/social/posts — create
// ---------------------------------------------------------------------------

/**
 * Create a new post. Authenticated users (any role) may call this.
 *
 * Flow:
 *   1. Validate body with `socialPostCreateSchema` (asserts caption,
 *      platform, status=SCHEDULED requires scheduledAt, etc.).
 *   2. Resolve `ownerId`:
 *        • If body.ownerId is set, use it (subject to RBAC check below).
 *        • Otherwise default to `session.userId`.
 *   3. RBAC: EMPLOYEEs may only assign new posts to themselves
 *      (parallels SPEC.md §6.4 for leads and §7 for campaigns).
 *      ADMINs may assign to anyone.
 *   4. Insert via Prisma. There are no unique constraints to translate
 *      here, so the shared `errorResponse` helper handles every other
 *      failure mode uniformly.
 *   5. Best-effort `socialpost.created` activity log — failures are
 *      swallowed so a missing audit row never tanks a successful write.
 *   6. Return the new post via `socialPostPublicProjection` (owner
 *      embedded).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const input = await parseJsonBody(req, socialPostCreateSchema);

    // Default ownership to the creator unless explicitly set.
    const resolvedOwnerId = input.ownerId ?? session.userId;

    // RBAC: employees may not assign new posts to other people.
    if (session.role === 'EMPLOYEE' && resolvedOwnerId !== session.userId) {
      throw new PermissionError(
        'write',
        'socialPost',
        'Employees can only assign new posts to themselves',
      );
    }

    const post = await prisma.socialPost.create({
      data: {
        platform: input.platform,
        status: input.status,
        caption: input.caption,
        mediaUrls: input.mediaUrls,
        hashtags: input.hashtags,
        ...(input.scheduledAt !== undefined
          ? { scheduledAt: input.scheduledAt }
          : {}),
        ...(input.externalId !== undefined
          ? { externalId: input.externalId }
          : {}),
        ...(input.externalUrl !== undefined
          ? { externalUrl: input.externalUrl }
          : {}),
        ownerId: resolvedOwnerId,
      },
      select: socialPostPublicProjection,
    });

    // Best-effort audit log. `logActivity` propagates errors by design
    // (see `src/lib/activity.ts`), so wrap it here to keep the route's
    // happy path resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.SOCIALPOST_CREATED,
        entityType: 'socialpost',
        entityId: post.id,
        metadata: {
          entityName: post.caption.slice(0, 80),
          platform: post.platform,
          status: post.status,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/social/posts] activity log failed', logErr);
    }

    return NextResponse.json(post as unknown as SocialPostPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
