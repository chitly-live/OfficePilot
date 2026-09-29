/**
 * `GET    /api/finance/transactions/[id]` — one ledger row.
 * `PATCH  /api/finance/transactions/[id]` — partial update.
 * `DELETE /api/finance/transactions/[id]` — hard delete (admin only).
 *
 * PATCH re-validates the direction ↔ category pairing and the
 * original-amount ↔ currency pairing against the MERGED row, since the
 * client may send only one half of each pair.
 *
 * Both PATCH and DELETE refuse rows dated inside a closed month (old date
 * and new date). A row settles one card (`settlesAccountId`) or carries a
 * split (`cardSplit`), never both; leaving CARD_REPAYMENT clears both.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { categoryDirection, categoryLabel, formatInr, round2 } from '@/lib/finance';
import { validateCardSplit, writeCardSplit, type CardSplitPart } from '@/lib/finance-guards';
import { resolveTransactionRefs } from '@/lib/finance-refs';
import { assertDatesOpen } from '@/lib/month-close';
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
    await requireFinanceReadSession();
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
        date: true,
        direction: true,
        category: true,
        amount: true,
        originalAmount: true,
        originalCurrency: true,
        partyId: true,
        viaPartyId: true,
        accountId: true,
        settlesAccountId: true,
        dueDate: true,
        description: true,
        cardAllocations: { select: { accountId: true, amount: true } },
        gstReturnAsCash: { select: { month: true } },
        gstReturnAsItc: { select: { month: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    await assertDatesOpen(prisma, [existing.date, input.date]);

    // Rows a GST return generated are owned by that return: the money fields
    // change on the GST page, or the two would disagree.
    // The edit form re-sends every field, so compare values, not keys.
    const gstMonth = existing.gstReturnAsCash?.month ?? existing.gstReturnAsItc?.month;
    if (gstMonth) {
      const time = (d: Date | null | undefined) => (d ? d.getTime() : null);
      const differs = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);
      const moneyChanged =
        (input.date !== undefined && time(input.date) !== time(existing.date)) ||
        (input.direction !== undefined && input.direction !== existing.direction) ||
        (input.category !== undefined && input.category !== existing.category) ||
        (input.amount !== undefined && Math.abs(input.amount - existing.amount) >= 0.005) ||
        (input.partyId !== undefined && differs(input.partyId, existing.partyId)) ||
        (input.viaPartyId !== undefined && differs(input.viaPartyId, existing.viaPartyId)) ||
        (input.accountId !== undefined && differs(input.accountId, existing.accountId)) ||
        (input.settlesAccountId !== undefined &&
          differs(input.settlesAccountId, existing.settlesAccountId)) ||
        (input.originalAmount !== undefined &&
          differs(
            input.originalAmount === null ? null : round2(input.originalAmount),
            existing.originalAmount === null ? null : round2(existing.originalAmount),
          )) ||
        (input.originalCurrency !== undefined &&
          differs(input.originalCurrency, existing.originalCurrency)) ||
        (input.dueDate !== undefined && time(input.dueDate) !== time(existing.dueDate)) ||
        (input.cardSplit !== undefined && input.cardSplit !== null && input.cardSplit.length > 0);
      if (moneyChanged) {
        throw new BadRequestError(
          `This row belongs to the GST return for ${gstMonth}. Change the amounts on the GST page.`,
        );
      }
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

    // Card settlement: work out the split this row should end up with.
    // `undefined` = leave the stored split alone.
    const nextAmount = input.amount ?? existing.amount;
    const hadSplit = existing.cardAllocations.length > 0;
    let nextSplit: CardSplitPart[] | undefined;
    if (nextCategory !== 'CARD_REPAYMENT') {
      // No longer a repayment, so it settles nothing.
      data.settlesAccountId = null;
      if (hadSplit) nextSplit = [];
    } else if (input.cardSplit !== undefined) {
      nextSplit = input.cardSplit ?? [];
      if (nextSplit.length > 0) {
        await validateCardSplit(
          prisma,
          { category: nextCategory, direction: nextDirection, amount: nextAmount },
          nextSplit,
        );
        data.settlesAccountId = null;
      }
    } else if (hadSplit && input.settlesAccountId) {
      // Switched to settling a single card.
      nextSplit = [];
    } else if (hadSplit && round2(nextAmount) !== round2(existing.amount)) {
      throw new BadRequestError(
        `This payment is split across cards. Change the split too so it adds up to ${formatInr(nextAmount)}.`,
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.financeTransaction.update({ where: { id }, data, select: { id: true } });
      if (nextSplit !== undefined) await writeCardSplit(tx, id, nextSplit);
      return tx.financeTransaction.findUniqueOrThrow({
        where: { id },
        select: financeTransactionProjection,
      });
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
        date: true,
        direction: true,
        category: true,
        amount: true,
        description: true,
        party: { select: { name: true } },
        gstReturnAsCash: { select: { month: true } },
        gstReturnAsItc: { select: { month: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    await assertDatesOpen(prisma, [existing.date]);
    const gstMonth = existing.gstReturnAsCash?.month ?? existing.gstReturnAsItc?.month;
    if (gstMonth) {
      throw new BadRequestError(
        `This row belongs to the GST return for ${gstMonth}. Change or remove it on the GST page.`,
      );
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
