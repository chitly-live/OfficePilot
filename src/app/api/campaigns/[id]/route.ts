/**
 * `GET`, `PATCH`, and `DELETE` for `/api/campaigns/[id]` (SPEC.md §7.3).
 *
 * Per-campaign endpoints for the Marketing module. Authorization splits
 * per verb:
 *
 *   GET    /api/campaigns/[id]   →  Authenticated. Both ADMIN and
 *                                   EMPLOYEE can read any campaign —
 *                                   campaigns are a shared workspace
 *                                   (SPEC.md §2.1).
 *   PATCH  /api/campaigns/[id]   →  Authenticated, ownership-scoped.
 *                                   ADMIN may update any campaign.
 *                                   EMPLOYEE may only update campaigns
 *                                   they own (`ownerId === userId`).
 *                                   Enforced via
 *                                   `assertCan('write', 'campaign',
 *                                   {ownerId})`. Additionally, only
 *                                   ADMIN may reassign a campaign to
 *                                   another user (employees may
 *                                   self-assign but cannot hand the
 *                                   campaign off).
 *   DELETE /api/campaigns/[id]   →  Admin only. Hard delete (parallels
 *                                   SPEC.md §6.3 for leads).
 *
 * Activity logging on PATCH cascades so the timeline reads naturally:
 * a single PATCH that bumps spend AND records new conversions produces
 * TWO rows (CAMPAIGN_SPENT_UPDATED + CAMPAIGN_METRICS_UPDATED). When
 * nothing "interesting" changed we emit a generic CAMPAIGN_UPDATED.
 * Logging is best-effort (try/catch) so a missing audit row never
 * tanks an otherwise successful write (SPEC.md §14).
 *
 * `Campaign.utmCampaign` is `@unique`; PATCH callers may collide with
 * an existing value, which Prisma throws as P2002. The shared
 * `errorResponse` helper translates that into a 409 with the offending
 * column in `target`.
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
  campaignPublicProjection,
  campaignUpdateSchema,
  type CampaignPublic,
} from '@/lib/schemas/campaigns';

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

/**
 * Numeric metric columns whose changes generate a
 * `CAMPAIGN_METRICS_UPDATED` audit row. `spent` is intentionally not
 * in this list — it gets its own `CAMPAIGN_SPENT_UPDATED` row with a
 * `delta` so spend changes are easy to filter in the timeline.
 */
const METRIC_FIELDS = [
  'impressions',
  'clicks',
  'signups',
  'conversions',
] as const;
type MetricField = (typeof METRIC_FIELDS)[number];

// ---------------------------------------------------------------------------
// GET /api/campaigns/[id]
// ---------------------------------------------------------------------------

/**
 * Fetch one campaign with embedded owner. Authenticated users (any
 * role) may call this — campaigns are a globally readable shared
 * workspace.
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

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: campaignPublicProjection,
    });

    if (!campaign) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(campaign as unknown as CampaignPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/[id]
// ---------------------------------------------------------------------------

/**
 * Partial update.
 *
 * Authorization (SPEC.md §2.1):
 *   • ADMIN          → may update any campaign and may reassign to any
 *                      user.
 *   • EMPLOYEE       → may only update campaigns they own (gated by
 *                      `assertCan('write', 'campaign', ...)`),
 *                      and may NOT reassign the campaign to another
 *                      user (self-assign is fine).
 *
 * Activity logging emits 1+ rows depending on what changed:
 *   • `spent` changed                          → CAMPAIGN_SPENT_UPDATED
 *                                                `{delta, newSpent}`.
 *   • Any of `impressions`, `clicks`,
 *     `signups`, `conversions` changed         → CAMPAIGN_METRICS_UPDATED
 *                                                `{fields: [...]}`.
 *   • Otherwise                                → CAMPAIGN_UPDATED.
 */
export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const input = await parseJsonBody(req, campaignUpdateSchema);

    // Look up the row before authorizing so the permission check can
    // see ownership AND so we can compute change-deltas for the
    // activity log without a second round-trip after the update.
    const existing = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        ownerId: true,
        spent: true,
        impressions: true,
        clicks: true,
        signups: true,
        conversions: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // RBAC: ADMIN passes unconditionally; EMPLOYEE only if owner.
    // Routed through the canonical predicate so the 403 shape is
    // identical across the codebase.
    assertCan(session, 'write', 'campaign', {
      ownerId: existing.ownerId,
    });

    // Only ADMIN may reassign a campaign to another user. An employee
    // may set `ownerId` to themselves (self-assign no-op when they
    // already own it) but cannot hand the campaign off.
    if (
      input.ownerId !== undefined &&
      input.ownerId !== existing.ownerId &&
      session.role === 'EMPLOYEE' &&
      input.ownerId !== session.userId
    ) {
      throw new PermissionError(
        'write',
        'campaign',
        'Only admins can reassign a campaign to another user',
      );
    }

    // Compute the effective change-set BEFORE we touch Prisma so we
    // can drive activity logging off a single source of truth.
    const spentChanging =
      input.spent !== undefined && input.spent !== existing.spent;
    const spentDelta = spentChanging
      ? (input.spent as number) - existing.spent
      : 0;

    const changedMetricFields: MetricField[] = METRIC_FIELDS.filter(
      (field) => {
        const next = input[field];
        return next !== undefined && next !== existing[field];
      },
    );

    // Build the Prisma `data` payload. Each field is conditionally
    // splatted so absent keys stay absent (Prisma treats missing
    // identically to `undefined`, but explicit splats keep the wire
    // payload tiny and grep-friendly).
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.channel !== undefined) data.channel = input.channel;
    if (input.status !== undefined) data.status = input.status;
    if (input.startDate !== undefined) data.startDate = input.startDate;
    if (input.endDate !== undefined) data.endDate = input.endDate;
    if (input.budget !== undefined) data.budget = input.budget;
    if (input.spent !== undefined) data.spent = input.spent;
    if (input.impressions !== undefined) data.impressions = input.impressions;
    if (input.clicks !== undefined) data.clicks = input.clicks;
    if (input.signups !== undefined) data.signups = input.signups;
    if (input.conversions !== undefined) data.conversions = input.conversions;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.utmSource !== undefined) data.utmSource = input.utmSource;
    if (input.utmMedium !== undefined) data.utmMedium = input.utmMedium;
    if (input.utmCampaign !== undefined) data.utmCampaign = input.utmCampaign;
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;

    const updated = await prisma.campaign.update({
      where: { id },
      data,
      select: campaignPublicProjection,
    });

    // Activity logging — fire all relevant rows in cascade so the
    // timeline reads naturally. Each call is wrapped in its own
    // try/catch so one failure doesn't suppress the rest, and so the
    // route's happy path stays resilient (SPEC.md §14).
    const logs: Array<Promise<unknown>> = [];

    if (spentChanging) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED,
          entityType: 'campaign',
          entityId: updated.id,
          metadata: {
            delta: spentDelta,
            newSpent: input.spent as number,
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error(
            '[api/campaigns/[id]] spent_updated log failed',
            logErr,
          );
        }),
      );
    }

    if (changedMetricFields.length > 0) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
          entityType: 'campaign',
          entityId: updated.id,
          metadata: {
            fields: changedMetricFields as unknown as string[],
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error(
            '[api/campaigns/[id]] metrics_updated log failed',
            logErr,
          );
        }),
      );
    }

    // Generic catch-all for "something else changed" updates so the
    // timeline isn't silent on edits that don't touch spend/metrics.
    if (logs.length === 0) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.CAMPAIGN_UPDATED,
          entityType: 'campaign',
          entityId: updated.id,
          metadata: {
            entityName: updated.name,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/campaigns/[id]] updated log failed', logErr);
        }),
      );
    }

    // Wait for all log writes so the response timing stays close to
    // the actual settlement of the audit trail. Errors are already
    // swallowed inside each promise above.
    await Promise.all(logs);

    return NextResponse.json(updated as unknown as CampaignPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/[id]
// ---------------------------------------------------------------------------

/**
 * Hard delete. Admin only (parallels SPEC.md §6.3 for leads).
 *
 * Logs `campaign.deleted` BEFORE the row is removed so the audit row
 * starts with the right reference + name. We capture the name in
 * `metadata` so the timeline can render a human-readable
 * "User deleted campaign X" after the campaign row is gone.
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
    const existing = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Best-effort audit log written first. Failures are swallowed so a
    // logging hiccup never blocks a destructive call the admin already
    // authorized.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.CAMPAIGN_DELETED,
        entityType: 'campaign',
        entityId: existing.id,
        metadata: {
          entityName: existing.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/campaigns/[id]] delete log failed', logErr);
    }

    await prisma.campaign.delete({ where: { id: existing.id } });

    // 204 No Content — body must be empty.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
