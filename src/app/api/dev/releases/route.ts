/**
 * `GET /api/dev/releases` — release log endpoint (SPEC.md §9.3,
 * §9.2.3, §9.4).
 *
 * Returns `DevTask` rows where `type = RELEASE`, ordered with
 * `releasedAt` desc (newest shipped first) and unshipped releases
 * (NULL `releasedAt`) bubbling to the bottom. Optional `?platform=`
 * filter narrows to a single platform — typical values are "iOS",
 * "Android", "Web" but the column is a free-form string so the
 * filter accepts any non-empty value.
 *
 * RBAC: authenticated only; both ADMIN and EMPLOYEE see the same
 * data (releases are a shared timeline).
 *
 * Response shape:
 *
 *   { items: DevTaskPublic[] }
 *
 * Pagination is intentionally omitted — release cadence is low
 * (weekly at most), so a flat list is the right surface even after
 * a year of operation. If the team ships more often than expected
 * we can add `?limit=` later without breaking callers.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { DevTaskType, type Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import {
  devReleasesQuerySchema,
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      devReleasesQuerySchema,
    );

    const where: Prisma.DevTaskWhereInput = { type: DevTaskType.RELEASE };
    if (query.platform !== undefined) {
      where.platform = query.platform;
    }

    // Two-key sort:
    //   1. `releasedAt desc` with NULLs last — newest shipped first,
    //      unshipped ("planned for v2.6.0") at the bottom. Postgres
    //      via Prisma supports `nulls: 'last'` directly.
    //   2. `createdAt desc` as a tie-breaker — two releases shipped
    //      on the same day fall back to "logged most recently first".
    const orderBy: Prisma.DevTaskOrderByWithRelationInput[] = [
      { releasedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'asc' },
    ];

    const items = await prisma.devTask.findMany({
      where,
      select: devTaskPublicProjection,
      orderBy,
    });

    return NextResponse.json({
      items: items as unknown as DevTaskPublic[],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
