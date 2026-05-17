/**
 * Integration tests for the dev-task collection + detail endpoints
 * (task 58 in `.kiro/specs/officepilot/tasks.md`).
 *
 * Exercises:
 *   • GET    /api/dev/tasks                — paginated list + filters.
 *   • POST   /api/dev/tasks                — create + activity log.
 *   • GET    /api/dev/tasks/[id]           — single-task fetch.
 *   • PATCH  /api/dev/tasks/[id]           — partial update + status
 *                                            transitions + audit log.
 *   • DELETE /api/dev/tasks/[id]           — admin-only hard delete.
 *
 * Validates: Requirements 8.1, 8.2, 8.4, 8.5, 15.2, 15.3
 * Spec references: SPEC.md §9.1, §9.2.1, §9.3, §9.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2 (happy / 401 / 403 / 400):
 *
 *   Verb / Endpoint                Happy   401   403                 400
 *   GET    /api/dev/tasks            ✓      ✓     —                   ✓
 *   POST   /api/dev/tasks            ✓      ✓     —                   ✓
 *   GET    /api/dev/tasks/[id]       ✓      ✓     —                   —
 *   PATCH  /api/dev/tasks/[id]       ✓      ✓     ✓ (employee)         ✓
 *   DELETE /api/dev/tasks/[id]       ✓      ✓     ✓ (employee)         —
 *
 * Per-endpoint specifics from the task brief:
 *   • POST defaults `status = TODO` and writes `devtask.created`.
 *   • PATCH walks TODO → DOING → DONE.
 *   • PATCH into DONE auto-stamps `completedAt`.
 *   • Every status change writes `devtask.moved {from, to}`.
 *   • DELETE returns 403 for non-admins (even if reporter/assignee).
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { describe, expect, it } from 'vitest';
import { DevTaskStatus, DevTaskType, Priority } from '@prisma/client';

import { GET as listTasks, POST as createTask } from '@/app/api/dev/tasks/route';
import {
  DELETE as deleteTask,
  GET as getTask,
  PATCH as patchTask,
} from '@/app/api/dev/tasks/[id]/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface SeedTaskOverrides {
  title?: string;
  type?: DevTaskType;
  status?: DevTaskStatus;
  priority?: Priority;
  assigneeId?: string | null;
  reporterId?: string;
  releaseVersion?: string;
  releasedAt?: Date | null;
  platform?: string;
  targetWeek?: Date | null;
  completedAt?: Date | null;
}

/**
 * Insert a `DevTask` row directly via Prisma. Always passes through a
 * `reporterId` (defaulting to the supplied caller) because the schema
 * marks `reporter` non-nullable. Every other field has a sane default
 * so individual tests only have to specify the fields they care about.
 */
async function seedTask(
  reporterId: string,
  overrides: SeedTaskOverrides = {},
): Promise<{ id: string }> {
  return prisma.devTask.create({
    data: {
      title: overrides.title ?? 'Seed task',
      type: overrides.type ?? DevTaskType.FEATURE,
      status: overrides.status ?? DevTaskStatus.TODO,
      priority: overrides.priority ?? Priority.MEDIUM,
      reporterId: overrides.reporterId ?? reporterId,
      ...(overrides.assigneeId !== undefined
        ? { assigneeId: overrides.assigneeId }
        : {}),
      ...(overrides.releaseVersion !== undefined
        ? { releaseVersion: overrides.releaseVersion }
        : {}),
      ...(overrides.releasedAt !== undefined
        ? { releasedAt: overrides.releasedAt }
        : {}),
      ...(overrides.platform !== undefined
        ? { platform: overrides.platform }
        : {}),
      ...(overrides.targetWeek !== undefined
        ? { targetWeek: overrides.targetWeek }
        : {}),
      ...(overrides.completedAt !== undefined
        ? { completedAt: overrides.completedAt }
        : {}),
    },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// GET /api/dev/tasks
// ---------------------------------------------------------------------------

describe('GET /api/dev/tasks — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await listTasks(
      buildJsonRequest('GET', 'http://test/api/dev/tasks'),
    );
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /api/dev/tasks — happy path', () => {
  it('returns the paginated list with total/page/pageSize for an authenticated employee', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await seedTask(admin.id, { title: 'Alpha' });
    await seedTask(admin.id, { title: 'Beta' });
    await seedTask(admin.id, { title: 'Gamma' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await listTasks(
      buildJsonRequest('GET', 'http://test/api/dev/tasks'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ title: string; reporter: { id: string } }>;
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.total).toBe(3);
    expect(body!.page).toBe(1);
    expect(body!.pageSize).toBe(50);
    expect(body!.items).toHaveLength(3);
    // The public projection embeds the reporter relation so the kanban
    // can render the author chip without a second round-trip.
    for (const item of body!.items) {
      expect(item.reporter.id).toBe(admin.id);
    }
  });

  it('honours the status filter (single value)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedTask(admin.id, { status: DevTaskStatus.TODO });
    await seedTask(admin.id, { status: DevTaskStatus.DOING });
    await seedTask(admin.id, { status: DevTaskStatus.DONE });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listTasks(
      buildJsonRequest('GET', 'http://test/api/dev/tasks?status=DOING'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ status: DevTaskStatus }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(1);
    expect(body!.items[0]!.status).toBe(DevTaskStatus.DOING);
  });

  it('honours the type filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedTask(admin.id, { type: DevTaskType.FEATURE });
    await seedTask(admin.id, { type: DevTaskType.BUG });
    await seedTask(admin.id, { type: DevTaskType.BUG });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listTasks(
      buildJsonRequest('GET', 'http://test/api/dev/tasks?type=BUG'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ type: DevTaskType }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((t) => t.type === DevTaskType.BUG)).toBe(true);
  });

  it('honours the assigneeId filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: bob } = await createTestUser({ role: 'EMPLOYEE' });
    await seedTask(admin.id, { assigneeId: alice.id });
    await seedTask(admin.id, { assigneeId: bob.id });
    await seedTask(admin.id, { assigneeId: bob.id });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listTasks(
      buildJsonRequest(
        'GET',
        `http://test/api/dev/tasks?assigneeId=${bob.id}`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ assigneeId: string }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((t) => t.assigneeId === bob.id)).toBe(true);
  });

  it('returns 400 when a query param is malformed (page=0)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listTasks(
      buildJsonRequest('GET', 'http://test/api/dev/tasks?page=0'),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/dev/tasks
// ---------------------------------------------------------------------------

describe('POST /api/dev/tasks — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        title: 'Should not persist',
      }),
    );
    expect(res.status).toBe(401);
    // No row should be created.
    expect(await prisma.devTask.count()).toBe(0);
  });
});

describe('POST /api/dev/tasks — happy path', () => {
  it('creates a task with default status=TODO and reporterId=session.userId', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        title: 'Polish kanban drag-drop',
        type: 'FEATURE',
        priority: 'HIGH',
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      title: string;
      status: DevTaskStatus;
      type: DevTaskType;
      priority: Priority;
      reporterId: string;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.title).toBe('Polish kanban drag-drop');
    // Default status — drives "new tasks land in the TODO column" UX.
    expect(body!.status).toBe(DevTaskStatus.TODO);
    expect(body!.type).toBe(DevTaskType.FEATURE);
    expect(body!.priority).toBe(Priority.HIGH);
    // Reporter defaults to the session user when omitted.
    expect(body!.reporterId).toBe(employee.id);

    const stored = await prisma.devTask.findUnique({
      where: { id: body!.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe(DevTaskStatus.TODO);
    expect(stored!.completedAt).toBeNull();
  });

  it('writes a `devtask.created` activity log row tied to the calling user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        title: 'Audited task',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: employee.id,
        action: 'devtask.created',
        entityType: 'devtask',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
  });
});

describe('POST /api/dev/tasks — validation', () => {
  it('returns 400 on an invalid `type` enum value', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        title: 'Bad type',
        type: 'NOT_A_REAL_TYPE',
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    // Defensive: nothing leaked into the DB.
    expect(await prisma.devTask.count()).toBe(0);
  });

  it('returns 400 on an invalid `priority` enum value', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        title: 'Bad priority',
        priority: 'EXTREME',
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.devTask.count()).toBe(0);
  });

  it('returns 400 when title is missing', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createTask(
      buildJsonRequest('POST', 'http://test/api/dev/tasks', {
        type: 'FEATURE',
      }),
    );

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

describe('GET /api/dev/tasks/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id);
    await setSession(null);

    const res = await getTask(
      buildJsonRequest('GET', `http://test/api/dev/tasks/${task.id}`),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns the task with embedded reporter when called by an authenticated user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const task = await seedTask(admin.id, { title: 'Detail target' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await getTask(
      buildJsonRequest('GET', `http://test/api/dev/tasks/${task.id}`),
      buildRouteContext(task.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      id: string;
      title: string;
      reporter: { id: string };
    }>(res);
    expect(body!.id).toBe(task.id);
    expect(body!.title).toBe('Detail target');
    expect(body!.reporter.id).toBe(admin.id);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/dev/tasks/[id] — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id);
    await setSession(null);

    const res = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {
        status: 'DOING',
      }),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE patches a task they neither reported nor are assigned', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    // Reporter = admin, assignee = null → the employee has no claim.
    const task = await seedTask(admin.id, { assigneeId: null });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {
        status: 'DOING',
      }),
      buildRouteContext(task.id),
    );

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');

    // Defensive: confirm the row was not mutated.
    const stored = await prisma.devTask.findUnique({
      where: { id: task.id },
    });
    expect(stored!.status).toBe(DevTaskStatus.TODO);
  });
});

describe('PATCH /api/dev/tasks/[id] — status transitions', () => {
  it('walks the kanban path TODO → DOING → DONE and stamps completedAt only on the DONE move', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id, { status: DevTaskStatus.TODO });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // 1) TODO → DOING
    const toDoing = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {
        status: 'DOING',
      }),
      buildRouteContext(task.id),
    );
    expect(toDoing.status).toBe(200);
    const doingBody = await getJson<{
      status: DevTaskStatus;
      completedAt: string | null;
    }>(toDoing);
    expect(doingBody!.status).toBe(DevTaskStatus.DOING);
    // No completion stamp on the intermediate hop.
    expect(doingBody!.completedAt).toBeNull();

    // 2) DOING → DONE — auto-stamp.
    const toDone = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {
        status: 'DONE',
      }),
      buildRouteContext(task.id),
    );
    expect(toDone.status).toBe(200);
    const doneBody = await getJson<{
      status: DevTaskStatus;
      completedAt: string | null;
    }>(toDone);
    expect(doneBody!.status).toBe(DevTaskStatus.DONE);
    expect(doneBody!.completedAt).not.toBeNull();
    // Sanity-check the wire format and that the timestamp is recent.
    const completedAt = new Date(doneBody!.completedAt as string);
    expect(Number.isNaN(completedAt.getTime())).toBe(false);
    expect(Date.now() - completedAt.getTime()).toBeLessThan(60_000);

    const stored = await prisma.devTask.findUnique({
      where: { id: task.id },
    });
    expect(stored!.completedAt).not.toBeNull();
  });

  it('writes `devtask.moved` with {from, to} metadata on every status change', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id, { status: DevTaskStatus.TODO });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {
        status: 'DOING',
      }),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(200);

    const movedLog = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'devtask.moved',
        entityType: 'devtask',
        entityId: task.id,
      },
    });
    expect(movedLog).not.toBeNull();
    expect(movedLog!.metadata).toMatchObject({ from: 'TODO', to: 'DOING' });
  });

  it('returns 400 on an empty PATCH body', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchTask(
      buildJsonRequest('PATCH', `http://test/api/dev/tasks/${task.id}`, {}),
      buildRouteContext(task.id),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/dev/tasks/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id);
    await setSession(null);

    const res = await deleteTask(
      buildJsonRequest('DELETE', `http://test/api/dev/tasks/${task.id}`),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(401);

    // Row is still there.
    expect(
      await prisma.devTask.count({ where: { id: task.id } }),
    ).toBe(1);
  });

  it('returns 403 for an EMPLOYEE — even when they are the reporter (admin-only delete)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    // Reporter is the same employee — but DELETE is admin-only, so the
    // creator-as-employee path is still 403.
    const task = await seedTask(employee.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await deleteTask(
      buildJsonRequest('DELETE', `http://test/api/dev/tasks/${task.id}`),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');

    // Confirm the row survives.
    expect(
      await prisma.devTask.count({ where: { id: task.id } }),
    ).toBe(1);
  });

  it('admin can hard-delete and the row is gone', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const task = await seedTask(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await deleteTask(
      buildJsonRequest('DELETE', `http://test/api/dev/tasks/${task.id}`),
      buildRouteContext(task.id),
    );
    expect(res.status).toBe(204);

    expect(
      await prisma.devTask.count({ where: { id: task.id } }),
    ).toBe(0);
  });
});
