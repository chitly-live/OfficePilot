/**
 * `GET`, `PATCH`, and `DELETE` for `/api/dev/tasks/[id]`
 * (SPEC.md §9.3, §9.4).
 *
 * Per-task endpoints for the Dev Tracking module. Authorization
 * splits per verb:
 *
 *   GET    /api/dev/tasks/[id]   →  Authenticated. Both ADMIN and
 *                                   EMPLOYEE can read any task — dev
 *                                   is a shared workspace
 *                                   (SPEC.md §2.1).
 *   PATCH  /api/dev/tasks/[id]   →  Authenticated, ownership-scoped.
 *                                   ADMIN may update any task.
 *                                   EMPLOYEE may only update tasks
 *                                   they own (assigneeId === userId)
 *                                   OR they reported (reporterId ===
 *                                   userId). Drag-drop on the kanban
 *                                   surfaces here — SPEC.md §9.4
 *                                   "Drag task from TODO → DOING →
 *                                   DB updated".
 *   DELETE /api/dev/tasks/[id]   →  Admin only. Hard delete (parallels
 *                                   SPEC.md §6.3 leads + §7.3
 *                                   campaigns + §8.3 social posts).
 *
 * Status-transition side effects (SPEC.md §9.4):
 *   • First transition into DONE auto-stamps `completedAt = now()` if
 *     the row doesn't already have one. Re-opening a DONE task
 *     (status moves back to TODO/DOING) clears `completedAt` so
 *     "completion" stays a single-instant signal.
 *   • Every status change emits a `devtask.moved` activity log row
 *     with `{from, to}` metadata — even when the move is into DONE.
 *   • The first transition into DONE additionally emits
 *     `devtask.completed` so dashboards can count completions
 *     without having to scan moved rows. A re-DONE (DONE→TODO→DONE)
 *     does NOT re-emit `devtask.completed` because `completedAt` is
 *     already set on the second transition.
 *
 * Logging is best-effort (try/catch) so a missing audit row never
 * tanks an otherwise successful write (SPEC.md §14).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { DevTaskStatus } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireSession,
} from '@/lib/api-helpers';
import { PermissionError } from '@/lib/permissions';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  devTaskPublicProjection,
  devTaskUpdateSchema,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

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
// GET /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

/**
 * Fetch one task with embedded assignee + reporter. Authenticated
 * users (any role) may call this — dev is a globally readable shared
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

    const task = await prisma.devTask.findUnique({
      where: { id },
      select: devTaskPublicProjection,
    });

    if (!task) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(task as unknown as DevTaskPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

/**
 * Partial update.
 *
 * Authorization (SPEC.md §2.1, §9):
 *   • ADMIN          → may update any task.
 *   • EMPLOYEE       → may update a task if they're the assignee OR
 *                      the reporter. The shared `permissions.can(...)`
 *                      predicate is keyed off `(ownerId, createdById)`
 *                      so we map `assigneeId → ownerId` and
 *                      `reporterId → createdById` when calling it.
 *
 * Side effects on status transitions (SPEC.md §9.4):
 *   • `existing.status !== DONE` → `input.status === DONE`
 *       1. Set `completedAt = now()` (only if not already set — if a
 *          stale `completedAt` is present from a previous DONE→TODO
 *          cycle we keep the *new* one for an accurate audit).
 *       2. Emit `devtask.moved {from, to}`.
 *       3. Emit `devtask.completed {taskType}`.
 *   • `existing.status === DONE` → `input.status !== DONE`
 *       1. Clear `completedAt` (re-open).
 *       2. Emit `devtask.moved {from, to}`.
 *   • Any other status change          → `devtask.moved {from, to}`.
 *   • No status change but other fields → no log row (drag-drop is
 *      the dominant traffic; non-status edits surface in the
 *      `updatedAt` column on detail views).
 */
export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const input = await parseJsonBody(req, devTaskUpdateSchema);

    // Look up the row before authorizing so the permission check can
    // see ownership AND so we can compute change-deltas for the
    // activity log without a second round-trip after the update.
    const existing = await prisma.devTask.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        assigneeId: true,
        reporterId: true,
        completedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // RBAC: ADMIN passes unconditionally; EMPLOYEE only if assignee
    // or reporter. We don't go through the canonical `assertCan` path
    // because `permissions.ts` keys ownership off
    // `(ownerId, createdById)` and we'd have to fabricate those names
    // anyway — a direct check is clearer and keeps the assignee /
    // reporter vocabulary consistent with the rest of the dev module.
    if (session.role !== 'ADMIN') {
      const isAssignee =
        existing.assigneeId !== null &&
        existing.assigneeId === session.userId;
      const isReporter = existing.reporterId === session.userId;
      if (!isAssignee && !isReporter) {
        throw new PermissionError(
          'write',
          'devTask',
          'Only the assignee, reporter, or an admin can update this task',
        );
      }
    }

    // Compute the effective change-set BEFORE we touch Prisma so we
    // can drive activity logging off a single source of truth.
    const statusChanging =
      input.status !== undefined && input.status !== existing.status;
    const justCompleted =
      statusChanging &&
      input.status === DevTaskStatus.DONE &&
      existing.status !== DevTaskStatus.DONE;
    const reopened =
      statusChanging &&
      existing.status === DevTaskStatus.DONE &&
      input.status !== DevTaskStatus.DONE;

    // Build the Prisma `data` payload. Each field is conditionally
    // splatted so absent keys stay absent (Prisma treats missing
    // identically to `undefined`, but explicit splats keep the wire
    // payload tiny and grep-friendly).
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.type !== undefined) data.type = input.type;
    if (input.status !== undefined) data.status = input.status;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.affectsVersion !== undefined) {
      data.affectsVersion = input.affectsVersion;
    }
    if (input.stepsToReproduce !== undefined) {
      data.stepsToReproduce = input.stepsToReproduce;
    }
    if (input.releaseVersion !== undefined) {
      data.releaseVersion = input.releaseVersion;
    }
    if (input.releasedAt !== undefined) data.releasedAt = input.releasedAt;
    if (input.platform !== undefined) data.platform = input.platform;
    if (input.targetWeek !== undefined) data.targetWeek = input.targetWeek;
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;

    // Auto-manage `completedAt` on DONE transitions. The schema does
    // NOT accept `completedAt` from clients, so this is the only path
    // by which the column can change — fabrication isn't possible.
    if (justCompleted) {
      data.completedAt = new Date();
    } else if (reopened) {
      data.completedAt = null;
    }

    const updated = await prisma.devTask.update({
      where: { id },
      data,
      select: devTaskPublicProjection,
    });

    const titlePreview = updated.title.slice(0, 80);

    // Activity logging — fire all relevant rows in cascade so the
    // timeline reads naturally. Each call is wrapped in its own
    // try/catch so one failure doesn't suppress the rest, and so the
    // route's happy path stays resilient (SPEC.md §14).
    const logs: Array<Promise<unknown>> = [];

    if (statusChanging) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.DEVTASK_MOVED,
          entityType: 'devtask',
          entityId: updated.id,
          metadata: {
            from: existing.status,
            to: input.status as string,
            entityName: titlePreview,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/dev/tasks/[id]] moved log failed', logErr);
        }),
      );
    }

    if (justCompleted) {
      logs.push(
        logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.DEVTASK_COMPLETED,
          entityType: 'devtask',
          entityId: updated.id,
          metadata: {
            taskType: updated.type,
            entityName: titlePreview,
          },
        }).catch((logErr) => {
          // eslint-disable-next-line no-console
          console.error('[api/dev/tasks/[id]] completed log failed', logErr);
        }),
      );
    }

    // Wait for all log writes so the response timing stays close to
    // the actual settlement of the audit trail. Errors are already
    // swallowed inside each promise above.
    if (logs.length > 0) {
      await Promise.all(logs);
    }

    return NextResponse.json(updated as unknown as DevTaskPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

/**
 * Hard delete. Admin only (parallels the rest of the modules).
 *
 * Logs `devtask.deleted` BEFORE the row is removed so the audit row
 * captures the title preview while the data is still available. The
 * `entityId` column still holds the deleted task's id for forensic
 * lookup after the row is gone.
 */
export async function DELETE(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    // Look up first so we can (a) return a clean 404 instead of
    // letting Prisma throw P2025, and (b) capture the title preview
    // for the audit log before the row is gone.
    const existing = await prisma.devTask.findUnique({
      where: { id },
      select: { id: true, title: true, type: true },
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
        action: ACTIVITY_ACTIONS.DEVTASK_DELETED,
        entityType: 'devtask',
        entityId: existing.id,
        metadata: {
          entityName: existing.title.slice(0, 80),
          taskType: existing.type,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/dev/tasks/[id]] delete log failed', logErr);
    }

    await prisma.devTask.delete({ where: { id: existing.id } });

    // 204 No Content — body must be empty.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
