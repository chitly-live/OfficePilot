/**
 * `GET`, `PATCH`, and `DELETE` for `/api/social/posts/[id]`
 * (SPEC.md §8.3).
 *
 * Per-post endpoints for the Social Media module. Authorization splits
 * per verb:
 *
 *   GET    /api/social/posts/[id]   →  Authenticated. Both ADMIN and
 *                                      EMPLOYEE can read any post —
 *                                      social is a shared workspace
 *                                      (SPEC.md §2.1).
 *   PATCH  /api/social/posts/[id]   →  Authenticated, ownership-scoped.
 *                                      ADMIN may update any post.
 *                                      EMPLOYEE may only update posts
 *                                      they own (`ownerId === userId`).
 *                                      Enforced via
 *                                      `assertCan('write', 'socialPost',
 *                                      {ownerId})`. Additionally, only
 *                                      ADMIN may reassign a post to
 *                                      another user.
 *   DELETE /api/social/posts/[id]   →  Admin only. Hard delete
 *                                      (parallels SPEC.md §6.3 for
 *                                      leads and §7.3 for campaigns).
 *
 * Activity logging on PATCH cascades so the timeline reads naturally.
 * Distinct rows are emitted for the meaningful events:
 *
 *   • Status crosses non-PUBLISHED → PUBLISHED  →  SOCIALPOST_PUBLISHED
 *     (the route also auto-stamps `publishedAt = now` if the caller
 *     didn't provide one — SPEC.md §8.2.2).
 *   • `isWinner` toggles                          →  SOCIALPOST_WINNER_MARKED
 *   • Anything else                               →  SOCIALPOST_UPDATED
 *
 * When more than one of the above fires (e.g. a single PATCH that
 * publishes AND marks a winner) we emit BOTH dedicated rows; we only
 * fall back to the generic SOCIALPOST_UPDATED when nothing else
 * matched. Logging is best-effort (try/catch) so a missing audit row
 * never tanks an otherwise successful write (SPEC.md §14).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { PostStatus } from '@prisma/client';

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
  socialPostPublicProjection,
  socialPostUpdateSchema,
  type SocialPostPublic,
} from '@/lib/schemas/social';

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
// GET /api/social/posts/[id]
// ---------------------------------------------------------------------------

/**
 * Fetch one post with embedded owner. Authenticated users (any role)
 * may call this — social is a globally readable shared workspace.
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

    const post = await prisma.socialPost.findUnique({
      where: { id },
      select: socialPostPublicProjection,
    });

    if (!post) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(post as unknown as SocialPostPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/social/posts/[id]
// ---------------------------------------------------------------------------

/**
 * Partial update.
 *
 * Authorization (SPEC.md §2.1):
 *   • ADMIN          → may update any post and may reassign to any user.
 *   • EMPLOYEE       → may only update posts they own (gated by
 *                      `assertCan('write', 'socialPost', ...)`),
 *                      and may NOT reassign the post to another user
 *                      (self-assign is fine).
 *
 * Side effects on status transitions:
 *   • Non-PUBLISHED → PUBLISHED auto-stamps `publishedAt = now()` if
 *     the client didn't provide one. SPEC.md §8.2.2 leaves the field
 *     nullable on schedule, so we own the canonical "first time
 *     published" timestamp here.
 *
 * Activity logging emits 1+ rows depending on what changed:
 *   • Status crosses non-PUBLISHED → PUBLISHED  →  SOCIALPOST_PUBLISHED
 *   • `isWinner` toggles                         →  SOCIALPOST_WINNER_MARKED
 *   • Otherwise                                  →  SOCIALPOST_UPDATED
 */
export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const input = await parseJsonBody(req, socialPostUpdateSchema);

    // Look up the row before authorizing so the permission check can
    // see ownership AND so we can compute change-deltas for the
    // activity log without a second round-trip after the update.
    const existing = await prisma.socialPost.findUnique({
      where: { id },
      select: {
        id: true,
        caption: true,
        platform: true,
        ownerId: true,
        status: true,
        publishedAt: true,
        isWinner: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // RBAC: ADMIN passes unconditionally; EMPLOYEE only if owner.
    // Routed through the canonical predicate so the 403 shape is
    // identical across the codebase.
    assertCan(session, 'write', 'socialPost', {
      ownerId: existing.ownerId,
    });

    // Only ADMIN may reassign a post to another user. An employee may
    // set `ownerId` to themselves (self-assign no-op when they
    // already own it) but cannot hand the post off.
    if (
      input.ownerId !== undefined &&
      input.ownerId !== existing.ownerId &&
      session.role === 'EMPLOYEE' &&
      input.ownerId !== session.userId
    ) {
      throw new PermissionError(
        'write',
        'socialPost',
        'Only admins can reassign a post to another user',
      );
    }

    // Compute the effective change-set BEFORE we touch Prisma so we
    // can drive activity logging off a single source of truth.
    const statusChanging =
      input.status !== undefined && input.status !== existing.status;
    const justPublished =
      statusChanging &&
      input.status === PostStatus.PUBLISHED &&
      existing.status !== PostStatus.PUBLISHED;
    const winnerChanging =
      input.isWinner !== undefined && input.isWinner !== existing.isWinner;

    // Build the Prisma `data` payload. Each field is conditionally
    // splatted so absent keys stay absent (Prisma treats missing
    // identically to `undefined`, but explicit splats keep the wire
    // payload tiny and grep-friendly).
    const data: Record<string, unknown> = {};
    if (input.platform !== undefined) data.platform = input.platform;
    if (input.status !== undefined) data.status = input.status;
    if (input.caption !== undefined) data.caption = input.caption;
    if (input.mediaUrls !== undefined) data.mediaUrls = input.mediaUrls;
    if (input.hashtags !== undefined) data.hashtags = input.hashtags;
    if (input.scheduledAt !== undefined) data.scheduledAt = input.scheduledAt;
    if (input.publishedAt !== undefined) data.publishedAt = input.publishedAt;
    if (input.externalId !== undefined) data.externalId = input.externalId;
    if (input.externalUrl !== undefined) data.externalUrl = input.externalUrl;
    if (input.likes !== undefined) data.likes = input.likes;
    if (input.comments !== undefined) data.comments = input.comments;
    if (input.shares !== undefined) data.shares = input.shares;
    if (input.reach !== undefined) data.reach = input.reach;
    if (input.impressions !== undefined) data.impressions = input.impressions;
    if (input.isWinner !== undefined) data.isWinner = input.isWinner;
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;

    // Auto-stamp `publishedAt` on the first transition to PUBLISHED
    // unless the client provided an explicit value. SPEC.md §8.2.2 —
    // status changes happen manually, so we own the canonical "first
    // time published" timestamp here.
    if (justPublished && input.publishedAt === undefined) {
      data.publishedAt = new Date();
    }

    const updated = await prisma.socialPost.update({
      where: { id },
      data,
      select: socialPostPublicProjection,
    });

    const captionPreview = updated.caption.slice(0, 80);

    // Activity logging — fire all relevant rows in cascade so the
    // timeline reads naturally. Each call is wrapped in its own
    // try/catch so one failure doesn't suppress the rest, and so the
    // route's happy path stays resilient (SPEC.md §14).
    const logs: Array<Promise<unknown>> = [];

    if (justPublished) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED,
          entityType: 'socialpost',
          entityId: updated.id,
          metadata: {
            platform: updated.platform,
            ...(updated.externalUrl
              ? { externalUrl: updated.externalUrl }
              : {}),
            entityName: captionPreview,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error(
            '[api/social/posts/[id]] published log failed',
            logErr,
          );
        }),
      );
    }

    if (winnerChanging) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED,
          entityType: 'socialpost',
          entityId: updated.id,
          metadata: {
            isWinner: updated.isWinner,
            entityName: captionPreview,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error(
            '[api/social/posts/[id]] winner_marked log failed',
            logErr,
          );
        }),
      );
    }

    // Generic catch-all for "something else changed" updates so the
    // timeline isn't silent on edits that don't touch publish/winner.
    if (logs.length === 0) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.SOCIALPOST_UPDATED,
          entityType: 'socialpost',
          entityId: updated.id,
          metadata: {
            entityName: captionPreview,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error(
            '[api/social/posts/[id]] updated log failed',
            logErr,
          );
        }),
      );
    }

    // Wait for all log writes so the response timing stays close to
    // the actual settlement of the audit trail. Errors are already
    // swallowed inside each promise above.
    await Promise.all(logs);

    return NextResponse.json(updated as unknown as SocialPostPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/social/posts/[id]
// ---------------------------------------------------------------------------

/**
 * Hard delete. Admin only (parallels SPEC.md §6.3 for leads and §7.3
 * for campaigns).
 *
 * Logs `socialpost.deleted` BEFORE the row is removed so the audit
 * row starts with the right reference + caption preview. We capture
 * the caption snippet in `metadata` so the timeline can render a
 * human-readable "User deleted social post X" after the row is gone.
 */
export async function DELETE(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    // Look up first so we can (a) return a clean 404 instead of
    // letting Prisma throw P2025, and (b) capture the caption preview
    // for the audit log before the row is gone.
    const existing = await prisma.socialPost.findUnique({
      where: { id },
      select: { id: true, caption: true, platform: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Best-effort audit log written first. Failures are swallowed so
    // a logging hiccup never blocks a destructive call the admin
    // already authorized.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.SOCIALPOST_DELETED,
        entityType: 'socialpost',
        entityId: existing.id,
        metadata: {
          entityName: existing.caption.slice(0, 80),
          platform: existing.platform,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/social/posts/[id]] delete log failed', logErr);
    }

    await prisma.socialPost.delete({ where: { id: existing.id } });

    // 204 No Content — body must be empty.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
