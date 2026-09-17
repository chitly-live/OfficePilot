/**
 * `GET  /api/finance/gst` — every monthly GST return, newest first.
 * `POST /api/finance/gst` — record a month (ADMIN or ACCOUNTANT).
 *
 * This is the one write an ACCOUNTANT may perform. Saving also writes the
 * two TAX ledger rows (see `src/lib/gst.ts`).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { monthLabel } from '@/lib/finance';
import { itcRunningBalances, syncGstLedgerRows } from '@/lib/gst';
import { gstReturnCreateSchema, gstReturnProjection, type GstReturnPublic } from '@/lib/schemas/gst';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireFinanceReadSession();
    const items = await prisma.gstReturn.findMany({
      select: gstReturnProjection,
      orderBy: [{ month: 'desc' }],
    });
    const totals = items.reduce(
      (acc, r) => ({
        itcClaimed: acc.itcClaimed + r.itcClaimed,
        itcUsed: acc.itcUsed + r.itcUsed,
        cashPaid: acc.cashPaid + r.cashPaid,
      }),
      { itcClaimed: 0, itcUsed: 0, cashPaid: 0 },
    );
    const balances = itcRunningBalances(items);
    return NextResponse.json({
      items: (items as unknown as GstReturnPublic[]).map((r) => ({
        ...r,
        itcBalance: balances.get(r.month) ?? 0,
      })),
      totals: { ...totals, itcBalance: Math.round((totals.itcClaimed - totals.itcUsed) * 100) / 100 },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ADMIN or ACCOUNTANT — the accountant's single write surface.
    const session = await requireFinanceReadSession();
    const input = await parseJsonBody(req, gstReturnCreateSchema);

    if (input.cashAccountId) {
      const acct = await prisma.financeAccount.findUnique({
        where: { id: input.cashAccountId },
        select: { id: true },
      });
      if (!acct) throw new BadRequestError('Account not found');
    }

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const figures = {
          month: input.month,
          itcUsed: input.itcUsed,
          cashPaid: input.cashPaid,
          paidOn: input.paidOn ?? null,
          cashAccountId: input.cashAccountId ?? null,
          reference: input.reference ?? null,
        };
        const rows = await syncGstLedgerRows(
          tx,
          figures,
          { cashTransactionId: null, itcTransactionId: null },
          session.userId,
        );
        return tx.gstReturn.create({
          data: {
            ...figures,
            itcClaimed: input.itcClaimed,
            notes: input.notes ?? null,
            ...rows,
            createdById: session.userId,
          },
          select: gstReturnProjection,
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return NextResponse.json(
          { error: 'conflict', message: `A return for ${monthLabel(input.month)} already exists — edit that one.` },
          { status: 409 },
        );
      }
      throw err;
    }

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.GST_RETURN_SAVED,
        entityType: 'gst_return',
        entityId: created.id,
        metadata: {
          entityName: monthLabel(created.month),
          itcClaimed: created.itcClaimed,
          itcUsed: created.itcUsed,
          cashPaid: created.cashPaid,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/gst] activity log failed', logErr);
    }

    return NextResponse.json(created as unknown as GstReturnPublic, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
