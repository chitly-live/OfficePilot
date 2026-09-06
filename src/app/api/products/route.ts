/**
 * `GET  /api/products` — every product (any signed-in user; feeds the header switcher).
 * `POST /api/products` — create one (admin).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { prisma } from '@/lib/db';
import { productCreateSchema, productProjection } from '@/lib/schemas/products';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireSession();
    const items = await prisma.product.findMany({
      select: productProjection,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return NextResponse.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const input = await parseJsonBody(req, productCreateSchema);

    let created;
    try {
      created = await prisma.product.create({
        data: {
          name: input.name,
          slug: input.slug,
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
        select: productProjection,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return NextResponse.json(
          { error: 'conflict', message: `A product with slug "${input.slug}" already exists` },
          { status: 409 },
        );
      }
      throw err;
    }

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.PRODUCT_CREATED,
        entityType: 'product',
        entityId: created.id,
        metadata: { entityName: created.name },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/products] activity log failed', logErr);
    }

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
