/**
 * `GET`, `PATCH`, and `DELETE` for `/api/leads/[id]` (SPEC.md §6.3).
 *
 * Per-lead endpoints for the Leads module. Authorization splits per
 * verb:
 *
 *   GET    /api/leads/[id]   →  Authenticated. Both ADMIN and EMPLOYEE
 *                               can read any lead — leads are a shared
 *                               pipeline (SPEC.md §2.1).
 *   PATCH  /api/leads/[id]   →  Authenticated, ownership-scoped.
 *                               ADMIN may update any lead.
 *                               EMPLOYEE may only update leads they
 *                               own (`ownerId === userId`) or created
 *                               (`createdById === userId`). Enforced
 *                               via `assertCan('write', 'lead', ...)`
 *                               on the existing row's ownership.
 *                               Additionally, only ADMIN may reassign
 *                               a lead to another user (an employee
 *                               can self-assign but cannot hand the
 *                               lead off — SPEC.md §6.4).
 *   DELETE /api/leads/[id]   →  Admin only. Hard delete (SPEC.md §6.3
 *                               explicitly: "DELETE … hard delete
 *                               (admin only)"). Prisma cascades remove
 *                               nothing automatically — `Note` rows
 *                               are unrelated FKs (entityType/entityId
 *                               are loose strings) and stay behind;
 *                               `ActivityLog.leadId` is `SET NULL` so
 *                               the audit trail is preserved.
 *
 * Activity logging on PATCH happens in cascading order so the
 * timeline reads naturally: a single PATCH that flips status to
 * CONVERTED and reassigns the owner produces THREE rows
 * (LEAD_STATUS_CHANGED, LEAD_CONVERTED, LEAD_ASSIGNED). When nothing
 * "interesting" changed we emit a generic LEAD_UPDATED. Logging is
 * best-effort (try/catch) so a missing audit row never tanks an
 * otherwise successful write (SPEC.md §14).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireSession,
} from '@/lib/api-helpers';
import { assertCan, PermissionError } from '@/lib/permissions';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  leadPublicProjection,
  leadUpdateSchema,
  type LeadPublic,
} from '@/lib/schemas/leads';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Next.js 14 App Router dynamic-segment context shape for `[id]`. */
interface RouteContext {
  params: { id: string };
}

// ---------------------------------------------------------------------------
// GET /api/leads/[id]
// ---------------------------------------------------------------------------

/**
 * Fetch one lead with embedded owner. Authenticated users (any role)
 * may call this — leads are a globally readable shared pipeline.
 *
 * Returns 404 with `{ error: 'not_found' }` when the row is missing.
 */
export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = context.params;

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: leadPublicProjection,
    });

    if (!lead) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(lead as unknown as LeadPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/leads/[id]
// ---------------------------------------------------------------------------

/**
 * Partial update.
 *
 * Authorization (SPEC.md §2.1, §6.4):
 *   • ADMIN          → may update any lead and may reassign to any user.
 *   • EMPLOYEE       → may only update leads they own or created
 *                      (gated by `assertCan('write', 'lead', ...)`),
 *                      and may NOT reassign the lead to another user
 *                      (self-assign is fine).
 *
 * Activity logging emits 1+ rows depending on what changed:
 *   • Status changed             → LEAD_STATUS_CHANGED `{from, to}`.
 *   • Status → CONVERTED (new)   → also LEAD_CONVERTED. The route
 *                                  also auto-sets `convertedAt = now`
 *                                  if the row hadn't already converted.
 *   • Owner changed (non-null)   → LEAD_ASSIGNED `{fromOwnerId, toOwnerId}`.
 *   • Otherwise                  → LEAD_UPDATED.
 */
export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const input = await parseJsonBody(req, leadUpdateSchema);

    // Look up the row before authorizing so the permission check can
    // see ownership AND so we can compute change-deltas for the
    // activity log without a second round-trip after the update.
    const existing = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        ownerId: true,
        createdById: true,
        convertedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // RBAC: ADMIN passes unconditionally; EMPLOYEE only if owner or
    // creator. Routed through the canonical predicate so the 403 shape
    // is identical across the codebase.
    assertCan(session, 'write', 'lead', {
      ownerId: existing.ownerId,
      createdById: existing.createdById,
    });

    // Only ADMIN may reassign a lead to another user. An employee can
    // technically set `ownerId` to themselves (self-assign) but cannot
    // hand the lead off — SPEC.md §6.4 "admin can assign to any user".
    if (
      input.ownerId !== undefined &&
      input.ownerId !== existing.ownerId &&
      session.role === 'EMPLOYEE' &&
      input.ownerId !== session.userId
    ) {
      throw new PermissionError(
        'write',
        'lead',
        'Only admins can reassign a lead to another user',
      );
    }

    // Compute the effective change-set BEFORE we touch Prisma so we
    // can drive activity logging off a single source of truth.
    const statusChanging =
      input.status !== undefined && input.status !== existing.status;
    const ownerChanging =
      input.ownerId !== undefined && input.ownerId !== existing.ownerId;
    const convertedNow =
      statusChanging &&
      input.status === 'CONVERTED' &&
      existing.convertedAt === null;

    // Build the Prisma `data` payload. Each field is conditionally
    // splatted so absent keys stay absent (Prisma treats missing
    // identically to `undefined`, but explicit splats keep the wire
    // payload tiny and grep-friendly).
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.email !== undefined) data.email = input.email;
    if (input.company !== undefined) data.company = input.company;
    if (input.city !== undefined) data.city = input.city;
    if (input.source !== undefined) data.source = input.source;
    if (input.status !== undefined) data.status = input.status;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.value !== undefined) data.value = input.value;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.tags !== undefined) data.tags = input.tags;
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;
    if (input.utmSource !== undefined) data.utmSource = input.utmSource;
    if (input.utmMedium !== undefined) data.utmMedium = input.utmMedium;
    if (input.utmCampaign !== undefined) data.utmCampaign = input.utmCampaign;
    if (input.nextFollowUpAt !== undefined) {
      data.nextFollowUpAt = input.nextFollowUpAt;
    }
    // v0.1.4 — Chitly-spreadsheet fields. Each splatted under
    // `!== undefined` so an explicit `null` (operator clearing the
    // cell) still reaches Prisma; only omitted keys are skipped.
    if (input.age !== undefined) data.age = input.age;
    if (input.activeSince !== undefined) data.activeSince = input.activeSince;
    if (input.languages !== undefined) data.languages = input.languages;
    if (input.extraDetails !== undefined) data.extraDetails = input.extraDetails;
    if (input.phoneType !== undefined) data.phoneType = input.phoneType;
    if (input.notOnWhatsapp !== undefined) {
      data.notOnWhatsapp = input.notOnWhatsapp;
    }
    if (input.address !== undefined) data.address = input.address;
    // Admin-only override of the lead's "Date" — backdate correction
    // (matches the spreadsheet "Date" column semantics).
    if (input.createdAt !== undefined) data.createdAt = input.createdAt;
    // Auto-stamp `convertedAt` on the first transition to CONVERTED.
    // We don't accept the field from clients (the schema rejects it),
    // so fabrication isn't possible — only the route can set it, and
    // only on the canonical first-time conversion.
    if (convertedNow) {
      data.convertedAt = new Date();
    }

    const updated = await prisma.lead.update({
      where: { id },
      data,
      select: leadPublicProjection,
    });

    // Activity logging — fire all relevant rows in cascade so the
    // timeline reads naturally. Each call is wrapped in its own
    // try/catch so one failure doesn't suppress the rest, and so the
    // route's happy path stays resilient (SPEC.md §14).
    const logs: Array<Promise<unknown>> = [];

    if (statusChanging) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
          entityType: 'lead',
          entityId: updated.id,
          leadId: updated.id,
          metadata: {
            from: existing.status,
            to: input.status as string,
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/leads/[id]] status_changed log failed', logErr);
        }),
      );
    }

    if (convertedNow) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.LEAD_CONVERTED,
          entityType: 'lead',
          entityId: updated.id,
          leadId: updated.id,
          metadata: {
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/leads/[id]] converted log failed', logErr);
        }),
      );
    }

    // LEAD_ASSIGNED only when the new owner is non-null. If the caller
    // is unassigning the lead (`ownerId: null`), the LEAD_ASSIGNED
    // metadata schema requires `toOwnerId: string`, so we treat it as
    // a generic update instead.
    if (ownerChanging && input.ownerId != null) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.LEAD_ASSIGNED,
          entityType: 'lead',
          entityId: updated.id,
          leadId: updated.id,
          metadata: {
            fromOwnerId: existing.ownerId,
            toOwnerId: input.ownerId,
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/leads/[id]] assigned log failed', logErr);
        }),
      );
    }

    // Generic catch-all for "something else changed" updates so the
    // timeline isn't silent on edits that don't touch status/owner.
    if (logs.length === 0) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.LEAD_UPDATED,
          entityType: 'lead',
          entityId: updated.id,
          leadId: updated.id,
          metadata: {
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/leads/[id]] updated log failed', logErr);
        }),
      );
    }

    // Wait for all log writes so the response timing stays close to
    // the actual settlement of the audit trail. Errors are already
    // swallowed inside each promise above.
    await Promise.all(logs);

    return NextResponse.json(updated as unknown as LeadPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/leads/[id]
// ---------------------------------------------------------------------------

/**
 * Hard delete. Admin only (SPEC.md §6.3).
 *
 * Schema-side cascades:
 *   • `Note` rows reference leads via the loose `(entityType, entityId)`
 *     pair (no FK), so they remain — historical context is preserved.
 *   • `ActivityLog.leadId` is `ON DELETE SET NULL`, so audit rows
 *     survive with `leadId = NULL`. The `entityId` column still holds
 *     the deleted lead's id for forensic lookup.
 *
 * Logs `lead.deleted` BEFORE the row is removed so the audit row's
 * `leadId` (which becomes NULL once we delete) at least starts with
 * the right reference. We also include the lead's name in `metadata`
 * so the timeline can render a human-readable "User deleted lead X"
 * after the lead row is gone.
 */
export async function DELETE(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    // Look up first so we can (a) return a clean 404 instead of
    // letting Prisma throw P2025, and (b) capture the name for the
    // audit log before the row is gone.
    const existing = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Best-effort audit log written first — the FK is `SET NULL`, so
    // logging post-delete would lose the `leadId` link. Failures are
    // swallowed so a logging hiccup never blocks a destructive call
    // the admin already authorized.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.LEAD_DELETED,
        entityType: 'lead',
        entityId: existing.id,
        leadId: existing.id,
        metadata: {
          entityName: existing.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/leads/[id]] delete log failed', logErr);
    }

    await prisma.lead.delete({ where: { id: existing.id } });

    // 204 No Content — body must be empty. NextResponse with `null`
    // body and status 204 is the canonical way to send this in Next.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
