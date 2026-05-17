/**
 * Integration tests for `GET /api/dev/roadmap` (task 58 in
 * `.kiro/specs/officepilot/tasks.md`).
 *
 * The endpoint groups `DevTask` rows by `targetWeek` (Monday-aligned)
 * for the next `weeks` weeks (default 8, max 52). Tasks without a
 * `targetWeek` are excluded — the roadmap is "what are we doing in
 * the next N weeks". See `src/app/api/dev/roadmap/route.ts` for the
 * contract.
 *
 * Validates: Requirements 8.1, 8.7, 15.2, 15.3
 * Spec references: SPEC.md §9.1.4, §9.3, §9.4, §16.2.
 *
 * Coverage matrix:
 *
 *   Verb / Endpoint             Happy   401   400 (zod)
 *   GET /api/dev/roadmap          ✓      ✓     ✓
 *
 * Per-endpoint specifics from the task brief:
 *   • Groups tasks by `targetWeek` for the next N weeks.
 *   • 401 without session.
 *   • Empty buckets still appear (the kanban-style UI renders fixed
 *     columns).
 *   • Tasks with NULL `targetWeek` are excluded.
 *   • Tasks beyond the horizon are excluded.
 */

import { describe, expect, it } from 'vitest';
import { DevTaskStatus, DevTaskType, Priority } from '@prisma/client';

import { GET as listRoadmap } from '@/app/api/dev/roadmap/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Local helpers — Monday-of-current-week math
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Mirror of the route's `startOfIsoWeek` so the test can compute the
 * same Monday boundary the route uses. Pure UTC math — no timezone
 * surprises.
 */
function startOfIsoWeek(now: Date): Date {
  const utcMidnight = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const day = utcMidnight.getUTCDay();
  const shift = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - shift);
  return utcMidnight;
}

function addUtcDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/**
 * Insert a `DevTask` with the supplied `targetWeek`. The route's
 * grouping logic floors the day-of-week, so passing the exact Monday
 * makes assertions easier to read.
 */
async function seedRoadmapTask(
  reporterId: string,
  targetWeek: Date | null,
  overrides: { title?: string } = {},
): Promise<{ id: string }> {
  return prisma.devTask.create({
    data: {
      title: overrides.title ?? 'Roadmap item',
      type: DevTaskType.FEATURE,
      status: DevTaskStatus.TODO,
      priority: Priority.MEDIUM,
      reporterId,
      ...(targetWeek !== null ? { targetWeek } : {}),
    },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// GET /api/dev/roadmap — auth
// ---------------------------------------------------------------------------

describe('GET /api/dev/roadmap — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap'),
    );
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/dev/roadmap — happy path
// ---------------------------------------------------------------------------

describe('GET /api/dev/roadmap — happy path', () => {
  it('returns N empty week buckets when the roadmap is unpopulated', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap?weeks=8'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      weeks: Array<{ weekStart: string; tasks: unknown[] }>;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.weeks).toHaveLength(8);
    // Every column starts empty.
    for (const bucket of body!.weeks) {
      expect(bucket.tasks).toEqual([]);
    }
    // Buckets are chronological — each subsequent weekStart is exactly
    // 7 days after the previous one.
    for (let i = 1; i < body!.weeks.length; i += 1) {
      const prev = new Date(body!.weeks[i - 1]!.weekStart).getTime();
      const curr = new Date(body!.weeks[i]!.weekStart).getTime();
      expect(curr - prev).toBe(7 * MS_PER_DAY);
    }
  });

  it('groups tasks by `targetWeek` into the right Monday buckets', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const firstMonday = startOfIsoWeek(new Date());

    // Two tasks in the current week, one in week+2, one outside the
    // 8-week horizon, one with NULL targetWeek (excluded entirely).
    await seedRoadmapTask(admin.id, firstMonday, { title: 'This-week A' });
    await seedRoadmapTask(admin.id, firstMonday, { title: 'This-week B' });
    await seedRoadmapTask(admin.id, addUtcDays(firstMonday, 14), {
      title: 'In two weeks',
    });
    await seedRoadmapTask(admin.id, addUtcDays(firstMonday, 9 * 7), {
      title: 'Beyond horizon',
    });
    await seedRoadmapTask(admin.id, null, { title: 'Unscheduled' });

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap?weeks=8'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      weeks: Array<{ weekStart: string; tasks: Array<{ title: string }> }>;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.weeks).toHaveLength(8);

    // Week 0 (current week) holds the two "This-week" tasks.
    expect(body!.weeks[0]!.tasks).toHaveLength(2);
    expect(body!.weeks[0]!.tasks.map((t) => t.title).sort()).toEqual([
      'This-week A',
      'This-week B',
    ]);
    // Week 2 holds the "In two weeks" task.
    expect(body!.weeks[2]!.tasks).toHaveLength(1);
    expect(body!.weeks[2]!.tasks[0]!.title).toBe('In two weeks');
    // All other weeks are empty (no other in-window tasks).
    for (const idx of [1, 3, 4, 5, 6, 7]) {
      expect(body!.weeks[idx]!.tasks).toEqual([]);
    }

    // Tasks beyond the horizon and unscheduled tasks must not appear
    // anywhere in the response.
    const allTitles = body!.weeks.flatMap((w) => w.tasks.map((t) => t.title));
    expect(allTitles).not.toContain('Beyond horizon');
    expect(allTitles).not.toContain('Unscheduled');
  });

  it('honours `weeks` (default 8 when omitted; custom value when supplied)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const defaultRes = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap'),
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = await getJson<{ weeks: unknown[] }>(defaultRes);
    expect(defaultBody!.weeks).toHaveLength(8);

    const customRes = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap?weeks=4'),
    );
    expect(customRes.status).toBe(200);
    const customBody = await getJson<{ weeks: unknown[] }>(customRes);
    expect(customBody!.weeks).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dev/roadmap — validation
// ---------------------------------------------------------------------------

describe('GET /api/dev/roadmap — validation', () => {
  it('returns 400 when `weeks` is out of range (e.g. weeks=0)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap?weeks=0'),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });

  it('returns 400 when `weeks` exceeds the upper bound (53)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listRoadmap(
      buildJsonRequest('GET', 'http://test/api/dev/roadmap?weeks=53'),
    );

    expect(res.status).toBe(400);
  });
});
