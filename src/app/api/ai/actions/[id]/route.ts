/**
 * `PATCH /api/ai/actions/[id]` — update an AI action's status
 * (v0.1.3 Theme 5).
 *
 * Authorization: ADMIN-only. The AIAction surface is admin-controlled
 * — employees never see it. Middleware gates /api/ai/* already, but
 * the handler also calls `requireAdminSession()` defensively.
 *
 * Body: `{ status: 'OPEN' | 'DONE' | 'DISMISSED' }`.
 *
 * Side effects:
 *   • Sets `status`. When moving to DONE/DISMISSED, stamps `resolvedAt`
 *     and `resolvedById`. Moving back to OPEN clears those fields.
 *   • Writes one `ai.action_resolved` (DONE) or `ai.action_dismissed`
 *     (DISMISSED) row to ActivityLog. OPEN→OPEN is a no-op log.
 *
 * Response: `{ id, status, resolvedAt, resolvedById }` on 200.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  requireAdminSession,
} from '@/lib/api-helpers';
import { logActivity } from '@/lib/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchBodySchema = z.object({
  status: z.enum(['OPEN', 'DONE', 'DISMISSED']),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const json = (await request.json().catch(() => null)) as unknown;
    const parsed = patchBodySchema.safeParse(json);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? 'Invalid body',
      );
    }
    const { status } = parsed.data;

    const existing = await prisma.aIAction.findUnique({
      where: { id: params.id },
      select: { id: true, status: true, scope: true, title: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'AIAction not found' },
        { status: 404 },
      );
    }

    const isResolving = status === 'DONE' || status === 'DISMISSED';
    const updated = await prisma.aIAction.update({
      where: { id: params.id },
      data: {
        status,
        resolvedAt: isResolving ? new Date() : null,
        resolvedById: isResolving ? session.userId : null,
      },
      select: {
        id: true,
        status: true,
        resolvedAt: true,
        resolvedById: true,
      },
    });

    // Best-effort activity log — only for DONE / DISMISSED transitions.
    // Re-opening (DONE/DISMISSED → OPEN) is a no-op in the audit feed;
    // the resolvedAt/resolvedById columns are cleared in the update above.
    if (existing.status !== status && (status === 'DONE' || status === 'DISMISSED')) {
      try {
        const action =
          status === 'DONE' ? 'ai.action_resolved' : 'ai.action_dismissed';
        await logActivity(prisma, {
          userId: session.userId,
          action,
          entityType: 'ai_action',
          entityId: existing.id,
          metadata: {
            scope: existing.scope,
            title: existing.title,
            from: existing.status,
            to: status,
          },
        });
      } catch {
        // Audit log failure must never tank the request (SPEC §14).
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
