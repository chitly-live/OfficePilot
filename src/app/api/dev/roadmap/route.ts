/**
 * `GET /api/dev/roadmap` — week-bucketed roadmap endpoint
 * (SPEC.md §9.1.4, §9.3, §9.4).
 *
 * Groups `DevTask` rows by `targetWeek` (Monday-aligned, ISO 8601
 * week start) for the next `weeks` weeks (default 8, max 52). Tasks
 * without a `targetWeek` are excluded — the roadmap surface is
 * scoped to "what are we doing in the next N weeks".
 *
 * Window:
 *   • The first bucket is the Monday of the *current* week (i.e. the
 *     Monday on or before "now"). A task scheduled for a day that's
 *     already passed in the current week (Monday → today) still
 *     belongs to "this week" — the week boundary is the canonical
 *     anchor.
 *   • The window extends `weeks` Mondays forward, half-open
 *     `[firstMonday, firstMonday + weeks*7d)`.
 *
 * Response shape:
 *
 *   {
 *     weeks: Array<{
 *       weekStart: ISO datetime (Monday at 00:00 UTC of that week),
 *       tasks: DevTaskPublic[]
 *     }>
 *   }
 *
 * The buckets are returned in chronological order. Empty weeks are
 * still included (with `tasks: []`) so the UI can render fixed
 * columns without re-deriving the calendar on the client.
 *
 * RBAC: authenticated only; both ADMIN and EMPLOYEE see the same
 * data.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import {
  devRoadmapQuerySchema,
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached response.
export const dynamic = 'force-dynamic';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Return the Monday at 00:00 UTC on or before `now`. Pure helper —
 * makes the bucket math testable without freezing the system clock.
 *
 * JavaScript's `Date.getUTCDay()` returns 0 (Sunday) → 6 (Saturday);
 * we want 0 (Monday) → 6 (Sunday). The shift `(day + 6) % 7` does
 * that conversion in one go.
 */
function startOfIsoWeek(now: Date): Date {
  const utcMidnight = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const day = utcMidnight.getUTCDay();
  const shift = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - shift);
  return utcMidnight;
}

/** Add `n` whole UTC days to `d` and return a fresh `Date`. */
function addUtcDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      devRoadmapQuerySchema,
    );

    const firstMonday = startOfIsoWeek(new Date());
    const lastMondayExclusive = addUtcDays(firstMonday, query.weeks * 7);

    // Fetch every task whose `targetWeek` falls inside the window.
    // We use a half-open range `[firstMonday, lastMondayExclusive)` so
    // a task whose targetWeek is exactly the boundary Monday lands
    // in the *next* week's bucket, not the current one.
    const where: Prisma.DevTaskWhereInput = {
      targetWeek: {
        gte: firstMonday,
        lt: lastMondayExclusive,
      },
    };

    const tasks = await prisma.devTask.findMany({
      where,
      select: devTaskPublicProjection,
      // Order tasks within a week by priority desc, then created desc
      // so the most pressing items render first inside each column.
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
    });

    // Pre-build the bucket array so empty weeks still appear as
    // explicit columns. The UI relies on this — week N+1 should
    // render even if nothing's scheduled, so users can drag tasks
    // there later.
    const buckets: Array<{
      weekStart: Date;
      tasks: DevTaskPublic[];
    }> = [];
    for (let i = 0; i < query.weeks; i += 1) {
      buckets.push({
        weekStart: addUtcDays(firstMonday, i * 7),
        tasks: [],
      });
    }

    // Distribute each task into its Monday-aligned bucket. We compute
    // the bucket index from `(task.targetWeek - firstMonday) / 7d`
    // and floor; the `where` clause already ensured the result lands
    // in `[0, query.weeks)`.
    for (const task of tasks) {
      if (!task.targetWeek) continue;
      const targetMs =
        startOfIsoWeek(task.targetWeek as unknown as Date).getTime();
      const idx = Math.floor((targetMs - firstMonday.getTime()) / (MS_PER_DAY * 7));
      if (idx >= 0 && idx < buckets.length) {
        buckets[idx]!.tasks.push(task as unknown as DevTaskPublic);
      }
    }

    return NextResponse.json({
      weeks: buckets.map((bucket) => ({
        weekStart: bucket.weekStart.toISOString(),
        tasks: bucket.tasks,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
