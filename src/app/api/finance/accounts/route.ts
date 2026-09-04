/**
 * `GET  /api/finance/accounts` — bank / cash / UPI / credit-card
 *                                 instruments, each with an all-time balance.
 * `POST /api/finance/accounts` — create one.
 *
 * Admin-only.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { resolveOwnerParty } from '@/lib/finance-refs';
import { loadAccountBalances } from '@/lib/finance-summary';
import {
  financeAccountCreateSchema,
  financeAccountListQuerySchema,
  financeAccountProjection,
  type FinanceAccountPublic,
} from '@/lib/schemas/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();
    const query = parseSearchParams(
      req.nextUrl.searchParams,
      financeAccountListQuerySchema,
    );

    const where: Prisma.FinanceAccountWhereInput = {};
    if (query.type && query.type.length > 0) where.type = { in: query.type };
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.ownerPartyId !== undefined) where.ownerPartyId = query.ownerPartyId;

    const [items, balances] = await Promise.all([
      prisma.financeAccount.findMany({
        where,
        select: financeAccountProjection,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      loadAccountBalances(prisma),
    ]);

    return NextResponse.json({
      items: items.map((a) => ({
        ...(a as unknown as FinanceAccountPublic),
        balance: balances.get(a.id) ?? a.openingBalance,
      })),
      total: items.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, financeAccountCreateSchema);

    await resolveOwnerParty(prisma, input.ownerPartyId);

    const created = await prisma.financeAccount.create({
      data: {
        name: input.name,
        type: input.type,
        ...(input.ownerPartyId !== undefined
          ? { ownerPartyId: input.ownerPartyId }
          : {}),
        openingBalance: input.openingBalance,
        ...(input.notes !== undefined && input.notes !== ''
          ? { notes: input.notes }
          : {}),
        isActive: input.isActive,
      },
      select: financeAccountProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_ACCOUNT_CREATED,
        entityType: 'finance_account',
        entityId: created.id,
        metadata: { entityName: created.name, accountType: created.type },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/accounts] activity log failed', logErr);
    }

    return NextResponse.json(created as unknown as FinanceAccountPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
