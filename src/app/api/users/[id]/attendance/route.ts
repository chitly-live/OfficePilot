/**
 * `POST /api/users/[id]/attendance` — mark daily attendance.
 *
 * Per SPEC.md §5.2 feature 4 ("Basic attendance log — daily mark:
 * present / leave / wfh / absent (employees mark their own; admin can
 * override)") and §5.4 ("Attendance for a date is unique per user (DB
 * constraint)").
 *
 * Authorization:
 *   • ADMIN              → can mark attendance for anyone.
 *   • EMPLOYEE (self)    → can mark only their own attendance.
 *   • EMPLOYEE (other)   → 403.
 *
 * The DB enforces `(userId, date)` uniqueness on the `Attendance`
 * model. Rather than translating Prisma's P2002 into a 409, we use
 * `prisma.attendance.upsert(...)` so re-marking the same date
 * overwrites the previous row idempotently. This matches the spec's
 * "daily mark" semantics — there's exactly one attendance row per
 * (user, day), and the latest write wins.
 *
 * Date normalization:
 *   `Attendance.date` is `@db.Date`, so Postgres drops any time
 *   component on write. We additionally floor the parsed Date to
 *   UTC midnight so the upsert WHERE key matches what the row would
 *   look like on round-trip read.
 *
 * Activity logging is best-effort (try/catch) so a missing audit row
 * never tanks a successful write — see SPEC.md §14 and the pattern
 * established in `src/app/api/users/route.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireSession,
} from '@/lib/api-helpers';
import { PermissionError } from '@/lib/permissions';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { attendanceSchema } from '@/lib/schemas/users';

// Force the Node runtime — Prisma requires it. `force-dynamic` keeps
// Next from caching the response of an authenticated POST.
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

// ---------------------------------------------------------------------------
// POST /api/users/[id]/attendance
// ---------------------------------------------------------------------------

/**
 * Mark or overwrite attendance for `(userId, date)`.
 *
 * Body shape (validated by `attendanceSchema`):
 *   {
 *     date: string | Date,           // ISO-8601; coerced to Date
 *     status: 'present' | 'leave' | 'wfh' | 'absent',
 *     notes?: string                 // ≤500 chars
 *   }
 *
 * Returns the upserted `Attendance` row. Returns 404 when the target
 * user does not exist (we look it up explicitly so the error shape
 * matches the rest of the `/api/users/[id]/*` family rather than
 * surfacing a Prisma foreign-key failure as a 500).
 */
export async function POST(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const isSelf = session.userId === id;
    const isAdmin = session.role === 'ADMIN';

    // Coarse role gate: only admin or the user themselves can mark
    // attendance on a user record. Reject before reading the body so
    // a brute-force scan can't enumerate user existence via 400 vs 403.
    if (!isAdmin && !isSelf) {
      throw new PermissionError('write', 'user');
    }

    // Confirm the target user exists. Surfaced as a 404 to match the
    // shape of `GET/PATCH/DELETE /api/users/[id]` rather than letting
    // a foreign-key violation bubble up as a 500.
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const input = await parseJsonBody(req, attendanceSchema);

    // Floor to UTC midnight so the upsert's compound `(userId, date)`
    // key is stable regardless of what time component the client
    // happens to send. Postgres stores the column as `@db.Date`, so
    // the time would be discarded on write anyway — doing it here
    // keeps the WHERE side aligned with the row that will exist.
    const date = new Date(
      Date.UTC(
        input.date.getUTCFullYear(),
        input.date.getUTCMonth(),
        input.date.getUTCDate(),
      ),
    );

    // Upsert on the compound unique index `@@unique([userId, date])`.
    // On a fresh `(user, day)` we insert; on a re-mark we overwrite
    // both `status` and `notes` so the row reflects the latest call
    // exactly. Setting `notes: input.notes ?? null` on the update
    // path means omitting `notes` clears any previous note.
    const record = await prisma.attendance.upsert({
      where: {
        userId_date: { userId: id, date },
      },
      create: {
        userId: id,
        date,
        status: input.status,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      update: {
        status: input.status,
        notes: input.notes ?? null,
      },
    });

    // Best-effort audit log. Logging failures must not fail the write.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.ATTENDANCE_MARKED,
        entityType: 'attendance',
        entityId: record.id,
        metadata: {
          // YYYY-MM-DD form for display / activity feed (the formatter
          // in `src/lib/activity.ts` reads this verbatim).
          date: record.date.toISOString().slice(0, 10),
          status: record.status,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[api/users/[id]/attendance] activity log failed',
        logErr,
      );
    }

    return NextResponse.json(record);
  } catch (err) {
    return errorResponse(err);
  }
}
