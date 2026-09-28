/**
 * `GET    /api/finance/close`              — closed months, lock date, drift.
 * `POST   /api/finance/close`              — close every open month up to `month`.
 * `DELETE /api/finance/close?month=YYYY-MM` — reopen the latest closed month.
 *
 * Reading is open to the accountant; closing and reopening are admin-only
 * (middleware refuses the accountant's non-GET here, and the handlers
 * re-check). See `src/lib/month-close.ts` for the lock rules.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { prisma } from '@/lib/db';
import { monthLabel } from '@/lib/finance';
import {
  closeThrough,
  isMonthKey,
  lastEndedMonth,
  latestClosedMonth,
  loadMonthCloses,
  reopenMonth,
} from '@/lib/month-close';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const closeBodySchema = z.object({
  month: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Month must look like YYYY-MM'),
  note: z.string().trim().max(500).optional(),
});

export async function GET(): Promise<NextResponse> {
  try {
    await requireFinanceReadSession();
    const [closes, lockedThrough] = await Promise.all([
      loadMonthCloses(prisma),
      latestClosedMonth(prisma),
    ]);
    return NextResponse.json({ lockedThrough, suggested: lastEndedMonth(), closes });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, closeBodySchema);
    const months = await closeThrough(prisma, input.month, session.userId, input.note || null);

    for (const month of months) {
      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.FINANCE_MONTH_CLOSED,
          entityType: 'finance_month',
          entityId: month,
          metadata: { entityName: monthLabel(month) },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/finance/close] activity log failed', logErr);
      }
    }

    return NextResponse.json({ closed: months, lockedThrough: input.month }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const month = req.nextUrl.searchParams.get('month') ?? '';
    if (!isMonthKey(month)) throw new BadRequestError('Month must look like YYYY-MM');
    await reopenMonth(prisma, month);

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_MONTH_REOPENED,
        entityType: 'finance_month',
        entityId: month,
        metadata: { entityName: monthLabel(month) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/close] activity log failed', logErr);
    }

    return NextResponse.json({ reopened: month, lockedThrough: await latestClosedMonth(prisma) });
  } catch (err) {
    return errorResponse(err);
  }
}
