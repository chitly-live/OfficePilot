/**
 * `GET /api/dev/tasks` and `POST /api/dev/tasks` — dev task collection
 * endpoints (SPEC.md §9.3).
 *
 *   GET  /api/dev/tasks  → filtered, paginated list (default 50/page,
 *                          max 200 — matches the social/leads lists).
 *   POST /api/dev/tasks  → create a task; creation is logged to
 *                          `ActivityLog` as `devtask.created`.
 *
 * RBAC (SPEC.md §2.1, §9):
 *   • Both ADMIN and EMPLOYEE can READ every task — dev is a shared
 *     workspace; visibility is global. The middleware in
 *     `src/middleware.ts` enforces authentication for `/api/dev/*`,
 *     so anonymous traffic is already 401.
 *   • Both ADMIN and EMPLOYEE can CREATE tasks. The reporter is
 *     auto-assigned to the caller unless the caller specifies
 *     otherwise:
 *       - ADMIN may set `reporterId` to anyone (handy for logging
 *         bugs on behalf of QA).
 *       - EMPLOYEE may only set `reporterId` to themselves; the
 *         server overrides any other value back to the session
 *         user. We don't 403 here because a "report as me" UX is
 *         the only reasonable EMPLOYEE flow.
 *     `assigneeId` is optional and unconstrained (any active user can
 *     be assigned a task — the kanban (SPEC.md §9.2.1) is built around
 *     re-assigning by drag-drop).
 *
 * Response shape for GET:
 *
 *   {
 *     items: DevTaskPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Response shape for POST: a single `DevTaskPublic` (with embedded
 * `assignee` and `reporter`) per `devTaskPublicProjection`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  devTaskCreateSchema,
  devTaskListQuerySchema,
  devTaskPublicProjection,
  type DevTaskPublic,
  type DevTaskSortKey,
} from '@/lib/schemas/dev';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Sort key mapping
// ---------------------------------------------------------------------------

/**
 * Map the friendly `sortBy` query keys to the actual `DevTask`
 * columns. Keeping the public API stable against future Prisma
 * renames is the whole point of this indirection.
 */
const SORT_COLUMN_BY_KEY: Record<
  DevTaskSortKey,
  keyof Prisma.DevTaskOrderByWithRelationInput
> = {
  created: 'createdAt',
  updated: 'updatedAt',
  priority: 'priority',
  targetWeek: 'targetWeek',
};

// ---------------------------------------------------------------------------
// GET /api/dev/tasks — paginated list
// ---------------------------------------------------------------------------

/**
 * List tasks, filterable by every dimension on the `/dev` surface
 * (SPEC.md §9.1, §9.3): type, status, priority, assignee, reporter,
 * free-text title/description search, and a `targetWeek` range for
 * the roadmap drilldown. Pagination via `page` + `pageSize` (default
 * 50, max 200).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      devTaskListQuerySchema,
    );

    // Build the Prisma `where` from whichever filters were supplied.
    // Every branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
    const where: Prisma.DevTaskWhereInput = {};

    if (query.type && query.type.length > 0) {
      where.type = { in: query.type };
    }
    if (query.status && query.status.length > 0) {
      where.status = { in: query.status };
    }
    if (query.priority && query.priority.length > 0) {
      where.priority = { in: query.priority };
    }
    if (query.assigneeId !== undefined) {
      where.assigneeId = query.assigneeId;
    }
    if (query.reporterId !== undefined) {
      where.reporterId = query.reporterId;
    }
    if (
      query.targetWeekFrom !== undefined ||
      query.targetWeekTo !== undefined
    ) {
      where.targetWeek = {
        ...(query.targetWeekFrom !== undefined
          ? { gte: query.targetWeekFrom }
          : {}),
        ...(query.targetWeekTo !== undefined
          ? { lte: query.targetWeekTo }
          : {}),
      };
    }
    if (query.search) {
      // Postgres native `ILIKE` via Prisma `mode: 'insensitive'`.
      // Search hits both title and description so a user typing
      // "login bug" finds it regardless of which field has the words.
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
    const orderBy: Prisma.DevTaskOrderByWithRelationInput[] = [
      { [sortColumn]: query.sortDir } as Prisma.DevTaskOrderByWithRelationInput,
      // Tie-breaker on `id` so the same `where`/`orderBy` always
      // produces the same page boundaries (important for paginated
      // UIs that re-fetch on filter changes).
      { id: 'asc' },
    ];

    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them, so a
    // single round-trip via `Promise.all` is the right call.
    const [items, total] = await Promise.all([
      prisma.devTask.findMany({
        where,
        select: devTaskPublicProjection,
        orderBy,
        skip,
        take: query.pageSize,
      }),
      prisma.devTask.count({ where }),
    ]);

    return NextResponse.json({
      items: items as unknown as DevTaskPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/dev/tasks — create
// ---------------------------------------------------------------------------

/**
 * Create a new task. Authenticated users (any role) may call this.
 *
 * Flow:
 *   1. Validate body with `devTaskCreateSchema` (asserts title,
 *      type-specific RELEASE fields, etc.).
 *   2. Resolve `reporterId`:
 *        • If body.reporterId is set AND the caller is an admin, use
 *          it.
 *        • Otherwise default to `session.userId` (the schema's
 *          `reporter` relation is required, so we always set this).
 *   3. `assigneeId` is optional and unconstrained.
 *   4. Insert via Prisma. There are no unique constraints to translate
 *      here, so the shared `errorResponse` helper handles every other
 *      failure mode uniformly.
 *   5. Best-effort `devtask.created` activity log — failures are
 *      swallowed so a missing audit row never tanks a successful
 *      write.
 *   6. Return the new task via `devTaskPublicProjection` (assignee +
 *      reporter embedded).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const input = await parseJsonBody(req, devTaskCreateSchema);

    // EMPLOYEEs can only report as themselves; ADMINs may override the
    // reporter (e.g. logging on behalf of QA). When no reporterId is
    // provided we default to the session user either way.
    const resolvedReporterId =
      session.role === 'ADMIN' && input.reporterId !== undefined
        ? input.reporterId
        : session.userId;

    const task = await prisma.devTask.create({
      data: {
        title: input.title,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        type: input.type,
        status: input.status,
        priority: input.priority,
        ...(input.affectsVersion !== undefined
          ? { affectsVersion: input.affectsVersion }
          : {}),
        ...(input.stepsToReproduce !== undefined
          ? { stepsToReproduce: input.stepsToReproduce }
          : {}),
        ...(input.releaseVersion !== undefined
          ? { releaseVersion: input.releaseVersion }
          : {}),
        ...(input.releasedAt !== undefined
          ? { releasedAt: input.releasedAt }
          : {}),
        ...(input.platform !== undefined
          ? { platform: input.platform }
          : {}),
        ...(input.targetWeek !== undefined
          ? { targetWeek: input.targetWeek }
          : {}),
        ...(input.assigneeId !== undefined
          ? { assigneeId: input.assigneeId }
          : {}),
        reporterId: resolvedReporterId,
      },
      select: devTaskPublicProjection,
    });

    // Best-effort audit log. `logActivity` propagates errors by design
    // (see `src/lib/activity.ts`), so wrap it here to keep the route's
    // happy path resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.DEVTASK_CREATED,
        entityType: 'devtask',
        entityId: task.id,
        metadata: {
          entityName: task.title.slice(0, 80),
          taskType: task.type,
          status: task.status,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/dev/tasks] activity log failed', logErr);
    }

    return NextResponse.json(task as unknown as DevTaskPublic, {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
