/**
 * `GET    /api/finance/accounts/[id]` — one account + all-time balance.
 * `PATCH  /api/finance/accounts/[id]` — partial update.
 * `DELETE /api/finance/accounts/[id]` — delete; 409 when transactions
 *                                        still reference it.
 *
 * Admin-only.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { resolveOwnerParty } from '@/lib/finance-refs';
import { loadAccountBalances } from '@/lib/finance-summary';
import {
  financeAccountProjection,
  financeAccountUpdateSchema,
  type FinanceAccountPublic,
} from '@/lib/schemas/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    await requireAdminSession();
    const { id } = context.params;

    const account = await prisma.financeAccount.findUnique({
      where: { id },
      select: financeAccountProjection,
    });
    if (!account) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const balances = await loadAccountBalances(prisma);
    return NextResponse.json({
      ...(account as unknown as FinanceAccountPublic),
      balance: balances.get(id) ?? account.openingBalance,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;
    const input = await parseJsonBody(req, financeAccountUpdateSchema);

    const existing = await prisma.financeAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (input.ownerPartyId) {
      await resolveOwnerParty(prisma, input.ownerPartyId);
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.ownerPartyId !== undefined) data.ownerPartyId = input.ownerPartyId;
    if (input.openingBalance !== undefined) data.openingBalance = input.openingBalance;
    if (input.notes !== undefined) {
      data.notes = input.notes === '' ? null : input.notes;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.creditLimit !== undefined) data.creditLimit = input.creditLimit;
    if (input.billingDay !== undefined) data.billingDay = input.billingDay;
    if (input.dueDay !== undefined) data.dueDay = input.dueDay;

    const updated = await prisma.financeAccount.update({
      where: { id },
      data,
      select: financeAccountProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_ACCOUNT_UPDATED,
        entityType: 'finance_account',
        entityId: updated.id,
        metadata: { entityName: updated.name, fields: Object.keys(data) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/accounts/[id]] activity log failed', logErr);
    }

    return NextResponse.json(updated as unknown as FinanceAccountPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    const existing = await prisma.financeAccount.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: { select: { transactions: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (existing._count.transactions > 0) {
      return NextResponse.json(
        {
          error: 'conflict',
          message:
            'This account still has transactions linked to it. Mark it inactive instead, or re-link those rows first.',
          transactions: existing._count.transactions,
        },
        { status: 409 },
      );
    }

    await prisma.financeAccount.delete({ where: { id: existing.id } });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_ACCOUNT_DELETED,
        entityType: 'finance_account',
        entityId: existing.id,
        metadata: { entityName: existing.name },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/accounts/[id]] delete log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
