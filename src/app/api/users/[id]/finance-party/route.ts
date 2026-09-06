/**
 * `POST /api/users/[id]/finance-party` — find or create the Finance party
 * that represents this employee (type EMPLOYEE, linked by `userId`), so a
 * salary payout can be recorded against it. Idempotent. Admin-only.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse, requireAdminSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { prisma } from '@/lib/db';
import { ensureEmployeeParty } from '@/lib/finance-employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

export async function POST(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const party = await ensureEmployeeParty(prisma, id, session.userId);

    if (party.created) {
      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.FINANCE_PARTY_CREATED,
          entityType: 'finance_party',
          entityId: party.id,
          metadata: { entityName: party.name, type: 'EMPLOYEE', linkedUserId: id },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/users/[id]/finance-party] activity log failed', logErr);
      }
    }

    return NextResponse.json(
      { id: party.id, name: party.name, created: party.created },
      { status: party.created ? 201 : 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
