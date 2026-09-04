/**
 * `GET  /api/finance/parties` — people / companies we transact with, each
 *                                with an all-time balance ("kitna dena hai").
 * `POST /api/finance/parties` — create one.
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
import { loadPartyBalances } from '@/lib/finance-summary';
import {
  financePartyCreateSchema,
  financePartyListQuerySchema,
  financePartyProjection,
  type FinancePartyPublic,
} from '@/lib/schemas/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();
    const query = parseSearchParams(
      req.nextUrl.searchParams,
      financePartyListQuerySchema,
    );

    const where: Prisma.FinancePartyWhereInput = {};
    if (query.type && query.type.length > 0) where.type = { in: query.type };
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await Promise.all([
      prisma.financeParty.findMany({
        where,
        select: financePartyProjection,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take: query.pageSize,
      }),
      prisma.financeParty.count({ where }),
    ]);

    const balances = await loadPartyBalances(
      prisma,
      items.map((p) => p.id),
    );

    return NextResponse.json({
      items: items.map((p) => ({
        ...(p as unknown as FinancePartyPublic),
        balance: balances.get(p.id) ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, financePartyCreateSchema);

    const created = await prisma.financeParty.create({
      data: {
        name: input.name,
        type: input.type,
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.notes !== undefined && input.notes !== ''
          ? { notes: input.notes }
          : {}),
        isActive: input.isActive,
        createdById: session.userId,
      },
      select: financePartyProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_PARTY_CREATED,
        entityType: 'finance_party',
        entityId: created.id,
        metadata: { entityName: created.name, partyType: created.type },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/parties] activity log failed', logErr);
    }

    return NextResponse.json(created as unknown as FinancePartyPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
