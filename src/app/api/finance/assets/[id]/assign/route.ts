/**
 * `POST /api/finance/assets/[id]/assign` — hand an asset to someone, move it,
 * or take it back. Closes the open assignment on `date` and opens the next,
 * so the trail of who had it when is never overwritten.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { BadRequestError, errorResponse, parseJsonBody, requireAdminSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { GONE_STATUSES, assertAssetRefs, currentHolder, handOver, statusAfterHandover } from '@/lib/assets';
import { prisma } from '@/lib/db';
import { assetAssignSchema, assetProjection } from '@/lib/schemas/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;
    const input = await parseJsonBody(req, assetAssignSchema);

    const existing = await prisma.asset.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (GONE_STATUSES.includes(existing.status) && !input.status) {
      throw new BadRequestError('This asset has been sold or scrapped. Change its status first.');
    }

    await assertAssetRefs(prisma, { toUserId: input.toUserId, toPartyId: input.toPartyId });

    const updated = await prisma.$transaction(async (tx) => {
      await handOver(tx, id, input, input.date, session.userId);
      await tx.asset.update({
        where: { id },
        data: { status: statusAfterHandover(input, input.status) },
      });
      return tx.asset.findUniqueOrThrow({ where: { id }, select: assetProjection });
    });

    const holder = currentHolder(updated.assignments);
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.ASSET_ASSIGNED,
        entityType: 'asset',
        entityId: id,
        metadata: {
          entityName: updated.name,
          ...(holder.kind !== 'company' ? { toName: holder.name } : {}),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/assets/[id]/assign] activity log failed', logErr);
    }

    return NextResponse.json({ ...updated, holder });
  } catch (err) {
    return errorResponse(err);
  }
}
