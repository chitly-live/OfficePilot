/**
 * `GET    /api/finance/parties/[id]` — party + all-time balance.
 * `PATCH  /api/finance/parties/[id]` — partial update.
 * `DELETE /api/finance/parties/[id]` — delete; 409 when transactions or
 *                                       accounts still reference it.
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
import { loadPartyBalance } from '@/lib/finance-summary';
import {
  financePartyProjection,
  financePartyUpdateSchema,
  type FinancePartyPublic,
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

    const party = await prisma.financeParty.findUnique({
      where: { id },
      select: financePartyProjection,
    });
    if (!party) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const balance = await loadPartyBalance(prisma, id);
    return NextResponse.json({
      ...(party as unknown as FinancePartyPublic),
      balance,
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
    const input = await parseJsonBody(req, financePartyUpdateSchema);

    const existing = await prisma.financeParty.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.email !== undefined) data.email = input.email;
    if (input.notes !== undefined) {
      data.notes = input.notes === '' ? null : input.notes;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const updated = await prisma.financeParty.update({
      where: { id },
      data,
      select: financePartyProjection,
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_PARTY_UPDATED,
        entityType: 'finance_party',
        entityId: updated.id,
        metadata: { entityName: updated.name, fields: Object.keys(data) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/parties/[id]] activity log failed', logErr);
    }

    return NextResponse.json(updated as unknown as FinancePartyPublic);
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

    const existing = await prisma.financeParty.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: { select: { transactions: true, accounts: true } },
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (existing._count.transactions > 0 || existing._count.accounts > 0) {
      return NextResponse.json(
        {
          error: 'conflict',
          message:
            'This party still has transactions or accounts linked to it. Mark it inactive instead, or re-link those rows first.',
          transactions: existing._count.transactions,
          accounts: existing._count.accounts,
        },
        { status: 409 },
      );
    }

    await prisma.financeParty.delete({ where: { id: existing.id } });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_PARTY_DELETED,
        entityType: 'finance_party',
        entityId: existing.id,
        metadata: { entityName: existing.name },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/parties/[id]] delete log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
