/**
 * `GET /api/social/winners` — gallery of winning posts (SPEC.md §8.3,
 * §8.2.4).
 *
 * Returns every post where `isWinner = true`, optionally filtered by
 * platform. The set is small by design (winners are hand-picked top
 * performers) so this endpoint isn't paginated — the `/social/winners`
 * page renders the entire collection as a card grid.
 *
 * Response shape:
 *
 *   {
 *     items: SocialPostPublic[],
 *     total: number
 *   }
 *
 * Authorisation: authenticated read for both ADMIN and EMPLOYEE
 * (SPEC.md §2.1 — social is a shared workspace).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import {
  socialPostPublicProjection,
  socialWinnersQuerySchema,
  type SocialPostPublic,
} from '@/lib/schemas/social';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Always render fresh — the winners gallery reflects live DB state.
export const dynamic = 'force-dynamic';

/**
 * Sensible upper bound on the gallery — winners are hand-picked, but
 * we cap the response to avoid pathological pages on a large database.
 * `MAX_WINNERS` is well above any realistic curated set.
 */
const MAX_WINNERS = 500;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      socialWinnersQuerySchema,
    );

    const where: Prisma.SocialPostWhereInput = { isWinner: true };
    if (query.platform && query.platform.length > 0) {
      where.platform = { in: query.platform };
    }

    // Ordering: most recently updated first, then `id` as a stable
    // tie-breaker. We sort on `updatedAt` (never null) rather than
    // `publishedAt` so winners that haven't yet been marked published
    // — a legitimate state for a "draft we know is great" — still
    // surface in chronological order.
    const orderBy: Prisma.SocialPostOrderByWithRelationInput[] = [
      { updatedAt: 'desc' },
      { id: 'asc' },
    ];

    const [items, total] = await Promise.all([
      prisma.socialPost.findMany({
        where,
        select: socialPostPublicProjection,
        orderBy,
        take: MAX_WINNERS,
      }),
      prisma.socialPost.count({ where }),
    ]);

    return NextResponse.json({
      items: items as unknown as SocialPostPublic[],
      total,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
