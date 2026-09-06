/**
 * `GET  /api/finance/transactions` — filtered, paginated ledger.
 * `POST /api/finance/transactions` — record one IN / OUT row.
 *
 * Admin-only (the Finance module is gated in `src/middleware.ts` and
 * re-checked here via `requireAdminSession`). Every write is audited to
 * `ActivityLog` on a best-effort basis.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { categoryLabel, summarizeRows } from '@/lib/finance';
import {
  buildTransactionOrderBy,
  buildTransactionWhere,
} from '@/lib/finance-query';
import { resolveTransactionRefs } from '@/lib/finance-refs';
import {
  financeTransactionCreateSchema,
  financeTransactionListQuerySchema,
  financeTransactionProjection,
  type FinanceTransactionPublic,
} from '@/lib/schemas/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();
    const query = parseSearchParams(
      req.nextUrl.searchParams,
      financeTransactionListQuerySchema,
    );

    const where = buildTransactionWhere(query);
    const orderBy = buildTransactionOrderBy(query);
    const skip = (query.page - 1) * query.pageSize;

    const [items, total, allMatching] = await Promise.all([
      prisma.financeTransaction.findMany({
        where,
        select: financeTransactionProjection,
        orderBy,
        skip,
        take: query.pageSize,
      }),
      prisma.financeTransaction.count({ where }),
      // Totals for the WHOLE filtered set (not just this page) so the UI
      // can show "filtered: ₹X in / ₹Y out".
      prisma.financeTransaction.findMany({
        where,
        select: { direction: true, category: true, amount: true },
      }),
    ]);

    return NextResponse.json({
      items: items as unknown as FinanceTransactionPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
      totals: summarizeRows(allMatching),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, financeTransactionCreateSchema);

    const refs = await resolveTransactionRefs(prisma, {
      partyId: input.partyId,
      viaPartyId: input.viaPartyId,
      accountId: input.accountId,
    });

    const created = await prisma.financeTransaction.create({
      data: {
        date: input.date,
        direction: input.direction,
        category: input.category,
        amount: input.amount,
        ...(input.originalAmount !== undefined
          ? { originalAmount: input.originalAmount }
          : {}),
        ...(input.originalCurrency !== undefined
          ? { originalCurrency: input.originalCurrency }
          : {}),
        ...(input.description !== undefined && input.description !== ''
          ? { description: input.description }
          : {}),
        ...(input.reference !== undefined && input.reference !== ''
          ? { reference: input.reference }
          : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
        ...(input.viaPartyId !== undefined ? { viaPartyId: input.viaPartyId } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        createdById: session.userId,
      },
      select: financeTransactionProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_TRANSACTION_CREATED,
        entityType: 'finance_transaction',
        entityId: created.id,
        metadata: {
          direction: created.direction,
          amount: created.amount,
          category: created.category,
          categoryLabel: categoryLabel(created.category),
          ...(refs.partyName ? { partyName: refs.partyName } : {}),
          ...(refs.viaPartyName ? { viaPartyName: refs.viaPartyName } : {}),
          ...(created.description ? { entityName: created.description } : {}),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/transactions] activity log failed', logErr);
    }

    return NextResponse.json(created as unknown as FinanceTransactionPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
