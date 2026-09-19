/**
 * `PATCH  /api/finance/gst/[id]` — change a month's figures (ADMIN or ACCOUNTANT).
 * `DELETE /api/finance/gst/[id]` — remove the return and its ledger rows (ADMIN).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { monthLabel } from '@/lib/finance';
import { deleteGstLedgerRows, syncGstLedgerRows } from '@/lib/gst';
import {
  gstReturnProjection,
  gstReturnUpdateSchema,
  withDerivedTotals,
  type GstReturnPublic,
} from '@/lib/schemas/gst';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function PATCH(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireFinanceReadSession();
    const { id } = context.params;
    const input = await parseJsonBody(req, gstReturnUpdateSchema);

    const existing = await prisma.gstReturn.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (input.cashAccountId) {
      const acct = await prisma.financeAccount.findUnique({
        where: { id: input.cashAccountId },
        select: { id: true },
      });
      if (!acct) throw new BadRequestError('Account not found');
    }

    const figures: {
      month: string;
      itcUsed: number;
      cashPaid: number;
      paidOn: Date | null;
      cashAccountId: string | null;
      reference: string | null;
    } = {
      month: existing.month,
      itcUsed: input.itcUsed ?? existing.itcUsed,
      cashPaid: input.cashPaid ?? existing.cashPaid,
      paidOn: input.paidOn !== undefined ? input.paidOn : existing.paidOn,
      cashAccountId:
        input.cashAccountId !== undefined ? input.cashAccountId : existing.cashAccountId,
      reference: input.reference !== undefined ? input.reference : existing.reference,
    };
    // Merge the head-wise numbers, then re-derive the totals from them when
    // any head carries a value (see `withDerivedTotals`).
    const heads = {
      itcClaimedIgst: input.itcClaimedIgst ?? existing.itcClaimedIgst,
      itcClaimedCgst: input.itcClaimedCgst ?? existing.itcClaimedCgst,
      itcClaimedSgst: input.itcClaimedSgst ?? existing.itcClaimedSgst,
      itcUsedIgst: input.itcUsedIgst ?? existing.itcUsedIgst,
      itcUsedCgst: input.itcUsedCgst ?? existing.itcUsedCgst,
      itcUsedSgst: input.itcUsedSgst ?? existing.itcUsedSgst,
      cashPaidIgst: input.cashPaidIgst ?? existing.cashPaidIgst,
      cashPaidCgst: input.cashPaidCgst ?? existing.cashPaidCgst,
      cashPaidSgst: input.cashPaidSgst ?? existing.cashPaidSgst,
    };
    let itcClaimed = input.itcClaimed ?? existing.itcClaimed;
    const derived = withDerivedTotals({
      ...heads,
      itcClaimed,
      itcUsed: figures.itcUsed,
      cashPaid: figures.cashPaid,
    });
    itcClaimed = derived.itcClaimed;
    figures.itcUsed = derived.itcUsed;
    figures.cashPaid = derived.cashPaid;

    if (itcClaimed <= 0 && figures.itcUsed <= 0 && figures.cashPaid <= 0) {
      throw new BadRequestError('Enter at least one amount: ITC claimed, ITC used or cash paid');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const rows = await syncGstLedgerRows(
        tx,
        figures,
        {
          cashTransactionId: existing.cashTransactionId,
          itcTransactionId: existing.itcTransactionId,
        },
        session.userId,
      );
      return tx.gstReturn.update({
        where: { id },
        data: {
          ...figures,
          ...heads,
          itcClaimed,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...rows,
        },
        select: gstReturnProjection,
      });
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.GST_RETURN_SAVED,
        entityType: 'gst_return',
        entityId: updated.id,
        metadata: {
          entityName: monthLabel(updated.month),
          itcUsed: updated.itcUsed,
          cashPaid: updated.cashPaid,
          fields: Object.keys(input),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/gst/[id]] activity log failed', logErr);
    }

    return NextResponse.json(updated as unknown as GstReturnPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    const existing = await prisma.gstReturn.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    await prisma.$transaction(async (tx) => {
      await tx.gstReturn.delete({ where: { id } });
      await deleteGstLedgerRows(tx, {
        cashTransactionId: existing.cashTransactionId,
        itcTransactionId: existing.itcTransactionId,
      });
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.GST_RETURN_DELETED,
        entityType: 'gst_return',
        entityId: id,
        metadata: { entityName: monthLabel(existing.month) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/gst/[id]] activity log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
