/**
 * `GET  /api/finance/assets` — the asset register, with current holder.
 * `POST /api/finance/assets` — add an asset, optionally handing it over.
 *
 * Reading is open to the accountant (assets sit on the balance sheet);
 * writes are admin-only — the middleware refuses the accountant's non-GET
 * under `/api/finance`, and the handler re-checks.
 */

import type { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';

import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireAdminSession,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { assertAssetRefs, currentHolder, handOver, statusAfterHandover } from '@/lib/assets';
import { prisma } from '@/lib/db';
import { assetCreateSchema, assetListQuerySchema, assetProjection } from '@/lib/schemas/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireFinanceReadSession();
    const query = parseSearchParams(req.nextUrl.searchParams, assetListQuerySchema);

    const where: Prisma.AssetWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.kind) where.kind = query.kind;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { identifier: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.holder) {
      const [kind, id] = query.holder.split(':');
      if (kind === 'user' && id) where.assignments = { some: { toDate: null, toUserId: id } };
      else if (kind === 'party' && id) where.assignments = { some: { toDate: null, toPartyId: id } };
      else if (kind === 'company') {
        where.assignments = { none: { toDate: null, OR: [{ toUserId: { not: null } }, { toPartyId: { not: null } }] } };
      }
    }

    const items = await prisma.asset.findMany({
      where,
      select: assetProjection,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return NextResponse.json({
      items: items.map((a) => ({ ...a, holder: currentHolder(a.assignments) })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, assetCreateSchema);

    await assertAssetRefs(prisma, {
      toUserId: input.holder?.toUserId,
      toPartyId: input.holder?.toPartyId,
      transactionId: input.transactionId,
      productId: input.productId,
    });

    const handedOver = Boolean(input.holder?.toUserId || input.holder?.toPartyId || input.holder?.location);
    const status = input.status ?? (handedOver ? statusAfterHandover(input.holder ?? {}) : 'IN_STOCK');

    const created = await prisma.$transaction(async (tx) => {
      const asset = await tx.asset.create({
        data: {
          name: input.name,
          kind: input.kind,
          category: input.category || null,
          identifier: input.identifier || null,
          purchaseDate: input.purchaseDate ?? null,
          cost: input.cost ?? null,
          transactionId: input.transactionId ?? null,
          status,
          renewsOn: input.renewsOn ?? null,
          notes: input.notes || null,
          productId: input.productId ?? null,
          createdById: session.userId,
        },
        select: { id: true },
      });
      if (handedOver && input.holder) {
        await handOver(tx, asset.id, input.holder, input.purchaseDate ?? new Date(), session.userId);
      }
      return tx.asset.findUniqueOrThrow({ where: { id: asset.id }, select: assetProjection });
    });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.ASSET_CREATED,
        entityType: 'asset',
        entityId: created.id,
        metadata: { entityName: created.name, cost: created.cost },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/finance/assets] activity log failed', logErr);
    }

    return NextResponse.json({ ...created, holder: currentHolder(created.assignments) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
