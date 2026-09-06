/**
 * `PATCH  /api/products/[id]` — rename / recolour / (de)activate / reorder (admin).
 * `DELETE /api/products/[id]` — only when no ledger rows reference it (admin).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse, parseJsonBody, requireAdminSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { prisma } from '@/lib/db';
import { productProjection, productUpdateSchema } from '@/lib/schemas/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function PATCH(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;
    const input = await parseJsonBody(req, productUpdateSchema);

    const existing = await prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.color !== undefined) data.color = input.color;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    const updated = await prisma.product.update({ where: { id }, data, select: productProjection });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.PRODUCT_UPDATED,
        entityType: 'product',
        entityId: updated.id,
        metadata: { entityName: updated.name, fields: Object.keys(data) },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/products/[id]] activity log failed', logErr);
    }

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    const existing = await prisma.product.findUnique({
      where: { id },
      select: { id: true, name: true, _count: { select: { transactions: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (existing._count.transactions > 0) {
      return NextResponse.json(
        {
          error: 'conflict',
          message: `${existing.name} has ${existing._count.transactions} transaction(s). Mark it inactive instead.`,
          transactions: existing._count.transactions,
        },
        { status: 409 },
      );
    }

    await prisma.product.delete({ where: { id } });

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.PRODUCT_DELETED,
        entityType: 'product',
        entityId: id,
        metadata: { entityName: existing.name },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/products/[id]] activity log failed', logErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
