/**
 * `GET    /api/finance/assets/[id]` — one asset with its full hand-over trail.
 * `PATCH  /api/finance/assets/[id]` — edit the facts (not the holder — use
 *                                     `/assign` so the trail is kept).
 * `DELETE /api/finance/assets/[id]` — remove a wrongly added asset. The
 *                                     payment it points at stays in the ledger.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { GONE_STATUSES, assertAssetRefs, closeOpenAssignment, currentHolder } from '@/lib/assets';
import { prisma } from '@/lib/db';
import { assetProjection, assetUpdateSchema } from '@/lib/schemas/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    await requireFinanceReadSession();
    const asset = await prisma.asset.findUnique({
      where: { id: context.params.id },
      select: assetProjection,
    });
    if (!asset) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ...asset, holder: currentHolder(asset.assignments) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;
    const input = await parseJsonBody(req, assetUpdateSchema);

    const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await assertAssetRefs(prisma, {
      transactionId: input.transactionId ?? undefined,
      productId: input.productId ?? undefined,
      assetId: id,
    });

    const data: Record<string, unknown> = {};
    for (const key of [
      'name',
      'kind',
      'status',
      'purchaseDate',
      'cost',
      'transactionId',
      'renewsOn',
      'productId',
    ] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    for (const key of ['category', 'identifier', 'notes'] as const) {
      if (input[key] !== undefined) data[key] = input[key] === '' ? null : input[key];
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id }, data, select: { id: true } });
      // Sold or scrapped: it has left the company, so nobody holds it now.
      if (input.status && GONE_STATUSES.includes(input.status) && !GONE_STATUSES.includes(existing.status)) {
        await closeOpenAssignment(tx, id, new Date());
      }
      return tx.asset.findUniqueOrThrow({ where: { id }, select: assetProjection });
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.ASSET_UPDATED,
        entityType: 'asset',
        entityId: id,
        metadata: { entityName: updated.name, fields: Object.keys(data) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/assets/[id]] activity log failed', logErr);
    }

    return NextResponse.json({ ...updated, holder: currentHolder(updated.assignments) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;
    const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await prisma.asset.delete({ where: { id } });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.ASSET_DELETED,
        entityType: 'asset',
        entityId: id,
        metadata: { entityName: existing.name },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/assets/[id]] delete log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
