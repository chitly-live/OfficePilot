/**
 * `GET /api/finance/summary?month=YYYY-MM` (or `?dateFrom=&dateTo=`).
 *
 * Income / expense / net for the window, category breakdowns, top
 * parties, per-account flow + balance, all-time outstanding balances
 * (what we owe), a 6-month trend and the most recent rows. Defaults
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
import { resolveProductScope } from '@/lib/products';
import { getProductContext } from '@/lib/products-server';
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

    // `?product=` overrides the header cookie; both fall back to "all".
    const ctx = await getProductContext(prisma);
    const scope =
      query.product !== undefined ? resolveProductScope(query.product, ctx.products) : ctx.scope;
    if (query.product !== undefined && query.product !== 'all' && scope.kind === 'all') {
      throw new BadRequestError('Unknown product');
    }

    const summary = await loadFinanceSummary(prisma, { from, to }, {
      scope,
      companyLabel: `${ctx.companyShort} (company-level)`,
    });
    return NextResponse.json({
      ...summary,
      scope: scope.kind,
      product: scope.kind === 'product' ? scope.product.slug : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
