/**
 * `GET    /api/finance/transactions/[id]` — one ledger row.
 * `PATCH  /api/finance/transactions/[id]` — partial update.
 * `DELETE /api/finance/transactions/[id]` — hard delete (admin only).
 *
 * PATCH re-validates the direction ↔ category pairing and the
 * original-amount ↔ currency pairing against the MERGED row, since the
 * client may send only one half of each pair.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { categoryDirection, categoryLabel } from '@/lib/finance';
import { resolveTransactionRefs } from '@/lib/finance-refs';
import {
  financeTransactionProjection,
  financeTransactionUpdateSchema,
  type FinanceTransactionPublic,
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

    const row = await prisma.financeTransaction.findUnique({
      where: { id },
      select: financeTransactionProjection,
    });
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(row as unknown as FinanceTransactionPublic);
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
    const input = await parseJsonBody(req, financeTransactionUpdateSchema);

    const existing = await prisma.financeTransaction.findUnique({
      where: { id },
      select: {
        id: true,
        direction: true,
        category: true,
        amount: true,
        originalAmount: true,
        originalCurrency: true,
        partyId: true,
        viaPartyId: true,
        accountId: true,
        description: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Direction ↔ category must agree on the merged row.
    const nextDirection = input.direction ?? existing.direction;
    const nextCategory = input.category ?? existing.category;
    if (categoryDirection(nextCategory) !== nextDirection) {
      throw new BadRequestError('Category does not match the direction');
    }

    // Original amount / currency travel together.
    const nextOriginalAmount =
      input.originalAmount !== undefined
        ? input.originalAmount
        : existing.originalAmount;
    const nextOriginalCurrency =
      input.originalCurrency !== undefined
        ? input.originalCurrency
        : existing.originalCurrency;
    if ((nextOriginalAmount === null) !== (nextOriginalCurrency === null)) {
      throw new BadRequestError(
        'Original amount and currency must be given together',
      );
    }

    // The intermediary can never be the counterparty itself — check the
    // merged row, since either side may be changing in this request.
    const nextPartyId =
      input.partyId !== undefined ? input.partyId : existing.partyId;
    const nextViaPartyId =
      input.viaPartyId !== undefined ? input.viaPartyId : existing.viaPartyId;
    if (nextPartyId && nextViaPartyId && nextPartyId === nextViaPartyId) {
      throw new BadRequestError(
        'Routed-via party must be different from the party',
      );
    }

    // Validate any (non-null) reference the client is setting.
    const refs = await resolveTransactionRefs(prisma, {
      partyId: input.partyId ?? undefined,
      viaPartyId: input.viaPartyId ?? undefined,
      accountId: input.accountId ?? undefined,
      settlesAccountId: input.settlesAccountId ?? undefined,
      productId: input.productId ?? undefined,
    });

    const data: Record<string, unknown> = {};
    if (input.date !== undefined) data.date = input.date;
    if (input.direction !== undefined) data.direction = input.direction;
    if (input.category !== undefined) data.category = input.category;
    if (input.amount !== undefined) data.amount = input.amount;
    if (input.originalAmount !== undefined) data.originalAmount = input.originalAmount;
    if (input.originalCurrency !== undefined) {
      data.originalCurrency = input.originalCurrency;
    }
    if (input.description !== undefined) {
      data.description =
        input.description === '' ? null : input.description;
    }
    if (input.reference !== undefined) {
      data.reference = input.reference === '' ? null : input.reference;
    }
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.partyId !== undefined) data.partyId = input.partyId;
    if (input.viaPartyId !== undefined) data.viaPartyId = input.viaPartyId;
    if (input.accountId !== undefined) data.accountId = input.accountId;
    if (input.settlesAccountId !== undefined) data.settlesAccountId = input.settlesAccountId;
    if (input.productId !== undefined) data.productId = input.productId;

    const updated = await prisma.financeTransaction.update({
      where: { id },
      data,
      select: financeTransactionProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_TRANSACTION_UPDATED,
        entityType: 'finance_transaction',
        entityId: updated.id,
        metadata: {
          direction: updated.direction,
          amount: updated.amount,
          category: updated.category,
          categoryLabel: categoryLabel(updated.category),
          ...(updated.party?.name
            ? { partyName: updated.party.name }
            : refs.partyName
              ? { partyName: refs.partyName }
              : {}),
          ...(updated.description ? { entityName: updated.description } : {}),
          fields: Object.keys(data),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/transactions/[id]] activity log failed', logErr);
    }

    return NextResponse.json(updated as unknown as FinanceTransactionPublic);
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

    const existing = await prisma.financeTransaction.findUnique({
      where: { id },
      select: {
        id: true,
        direction: true,
        category: true,
        amount: true,
        description: true,
        party: { select: { name: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    await prisma.financeTransaction.delete({ where: { id: existing.id } });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_TRANSACTION_DELETED,
        entityType: 'finance_transaction',
        entityId: existing.id,
        metadata: {
          direction: existing.direction,
          amount: existing.amount,
          category: existing.category,
          categoryLabel: categoryLabel(existing.category),
          ...(existing.party?.name ? { partyName: existing.party.name } : {}),
          ...(existing.description ? { entityName: existing.description } : {}),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/transactions/[id]] delete log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
