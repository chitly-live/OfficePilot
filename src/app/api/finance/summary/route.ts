/**
 * `GET /api/finance/summary?month=YYYY-MM` (or `?dateFrom=&dateTo=`).
 *
 * Income / expense / net for the window, category breakdowns, top
 * parties, per-account flow + balance, all-time outstanding balances
 * ("kitna dena hai"), a 6-month trend and the most recent rows. Defaults
 * to the current UTC month. Admin-only.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import { monthRange, toMonthKey } from '@/lib/finance';
import { loadFinanceSummary } from '@/lib/finance-summary';
import { financeSummaryQuerySchema } from '@/lib/schemas/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();
    const query = parseSearchParams(
      req.nextUrl.searchParams,
      financeSummaryQuerySchema,
    );

    let from: Date;
    let to: Date;
    if (query.dateFrom !== undefined && query.dateTo !== undefined) {
      from = query.dateFrom;
      to = query.dateTo;
    } else {
      const key = query.month ?? toMonthKey(new Date());
      const range = monthRange(key);
      if (!range) {
        throw new BadRequestError('Invalid month');
      }
      from = range.from;
      to = range.to;
    }

    const summary = await loadFinanceSummary(prisma, { from, to });
    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
