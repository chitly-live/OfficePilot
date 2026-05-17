/**
 * `GET /api/users/[id]/stats` — performance snapshot for an employee.
 *
 * Per SPEC.md §5.2 feature 6 ("Performance snapshot card: leads owned,
 * leads converted, campaigns owned, tasks completed (30d) — pulled
 * live from DB") and §5.3.
 *
 * Authorization:
 *   • ADMIN              → can view anyone's stats.
 *   • EMPLOYEE (self)    → can view their own stats.
 *   • EMPLOYEE (other)   → 403 (cross-user reads of performance data
 *                          are admin-only — same gate as `GET
 *                          /api/users/[id]`).
 *
 * Response shape:
 *   {
 *     leadsOwned: number,
 *     leadsConverted: number,
 *     campaignsOwned: number,
 *     socialPostsOwned: number,
 *     devTasksAssigned: number,
 *     devTasksCompleted: number,
 *     attendanceLast30Days: {
 *       present: number,
 *       leave:   number,
 *       wfh:     number,
 *       absent:  number
 *     },
 *     conversionRate: number   // leadsConverted / leadsOwned, 0 when leadsOwned == 0
 *   }
 *
 * Counts are computed in parallel via a single `Promise.all` so the
 * round-trip is one DB hop's worth of latency rather than seven.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { LeadStatus, DevTaskStatus } from '@prisma/client';
import { subDays, startOfDay } from 'date-fns';

import { prisma } from '@/lib/db';
import { errorResponse, requireSession } from '@/lib/api-helpers';
import { PermissionError } from '@/lib/permissions';
import { ATTENDANCE_STATUSES, type AttendanceStatus } from '@/lib/schemas/users';

// Force the Node runtime — Prisma requires it. `force-dynamic` keeps
// Next from caching authenticated stat reads.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Next.js 14 App Router dynamic-segment context shape for `[id]`.
 */
interface RouteContext {
  params: { id: string };
}

/**
 * Per-status attendance counts over the rolling 30-day window. Every
 * key is always present (defaulting to `0`) so the client can render
 * a stable card without null-checks.
 */
type AttendanceWindowCounts = Record<AttendanceStatus, number>;

interface UserStats {
  leadsOwned: number;
  leadsConverted: number;
  campaignsOwned: number;
  socialPostsOwned: number;
  devTasksAssigned: number;
  devTasksCompleted: number;
  attendanceLast30Days: AttendanceWindowCounts;
  conversionRate: number;
}

/** Width of the rolling attendance window. */
const ATTENDANCE_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// GET /api/users/[id]/stats
// ---------------------------------------------------------------------------

/**
 * Compute the performance snapshot for a single user.
 *
 * The seven counts (six totals + one grouped attendance read) all
 * scope to `userId === id` and are mutually independent, so they run
 * in parallel via `Promise.all`. The attendance window is computed
 * from "now" using `date-fns` and floored to start-of-day so the
 * result is stable across multiple calls within the same day.
 */
export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    // Authorization: an EMPLOYEE may only read their own stats. ADMIN
    // is allowed unconditionally. We use the typed `PermissionError`
    // so the 403 response is shaped identically to other handlers.
    if (session.role !== 'ADMIN' && session.userId !== id) {
      throw new PermissionError('read', 'user');
    }

    // Floor to start-of-day so the 30-day window aligns to date-only
    // boundaries (matches the `@db.Date` storage of `Attendance.date`).
    const windowStart = startOfDay(subDays(new Date(), ATTENDANCE_WINDOW_DAYS));

    const [
      leadsOwned,
      leadsConverted,
      campaignsOwned,
      socialPostsOwned,
      devTasksAssigned,
      devTasksCompleted,
      attendanceGroups,
    ] = await Promise.all([
      prisma.lead.count({ where: { ownerId: id } }),
      prisma.lead.count({
        where: { ownerId: id, status: LeadStatus.CONVERTED },
      }),
      prisma.campaign.count({ where: { ownerId: id } }),
      prisma.socialPost.count({ where: { ownerId: id } }),
      prisma.devTask.count({ where: { assigneeId: id } }),
      prisma.devTask.count({
        where: { assigneeId: id, status: DevTaskStatus.DONE },
      }),
      // GroupBy gives us one row per distinct status with a `_count`
      // aggregate — cheaper than four separate counts and lets us
      // detect any non-canonical status rows (which we silently drop).
      prisma.attendance.groupBy({
        by: ['status'],
        where: {
          userId: id,
          date: { gte: windowStart },
        },
        _count: { _all: true },
      }),
    ]);

    // Initialise every canonical status to 0 so the client always
    // sees a stable shape, then fold the GROUP BY rows on top.
    const attendanceLast30Days: AttendanceWindowCounts = {
      present: 0,
      leave: 0,
      wfh: 0,
      absent: 0,
    };
    for (const row of attendanceGroups) {
      // Status is a free-form string in the DB (see `schema.prisma`)
      // but Zod enforces the closed set on write. Defensive narrowing
      // here keeps stray legacy rows from flipping into the response.
      if ((ATTENDANCE_STATUSES as readonly string[]).includes(row.status)) {
        attendanceLast30Days[row.status as AttendanceStatus] = row._count._all;
      }
    }

    // Conversion rate as a fraction in [0, 1]. Guard against
    // `leadsOwned === 0` so we don't return `NaN`.
    const conversionRate =
      leadsOwned > 0 ? leadsConverted / leadsOwned : 0;

    const body: UserStats = {
      leadsOwned,
      leadsConverted,
      campaignsOwned,
      socialPostsOwned,
      devTasksAssigned,
      devTasksCompleted,
      attendanceLast30Days,
      conversionRate,
    };

    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
