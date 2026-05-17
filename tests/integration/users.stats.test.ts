/**
 * Integration tests for `GET /api/users/[id]/stats` (task 29).
 *
 * Validates: Requirements 4.7, 4.9, 15.2, 15.3
 * Spec references: SPEC.md §5.2 (feature 6), §5.3, §16.2.
 *
 * Coverage:
 *   - 401 when no session.
 *   - 403 when an employee tries to read someone else's stats.
 *   - 200 when admin reads any user's stats.
 *   - 200 when employee reads their own stats.
 *   - Counts are correct: leadsOwned, leadsConverted, campaignsOwned,
 *     socialPostsOwned, devTasksAssigned, devTasksCompleted,
 *     attendanceLast30Days bucket, conversionRate.
 *   - Empty user → all-zero stats with conversionRate=0 (no NaN).
 */

import { addDays } from 'date-fns';
import { describe, expect, it } from 'vitest';

import { GET } from '@/app/api/users/[id]/stats/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

interface StatsResponse {
  leadsOwned: number;
  leadsConverted: number;
  campaignsOwned: number;
  socialPostsOwned: number;
  devTasksAssigned: number;
  devTasksCompleted: number;
  attendanceLast30Days: {
    present: number;
    leave: number;
    wfh: number;
    absent: number;
  };
  conversionRate: number;
}

describe('GET /api/users/[id]/stats — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user } = await createTestUser();
    await setSession(null);

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${user.id}/stats`),
      buildRouteContext(user.id),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when an employee reads another user's stats", async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${other.id}/stats`),
      buildRouteContext(other.id),
    );
    expect(res.status).toBe(403);
  });

  it('admin can read any user stats', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${target.id}/stats`),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);
  });

  it('employee can read their own stats', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}/stats`),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /api/users/[id]/stats — counts', () => {
  it('returns all-zero counts for an empty user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}/stats`),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);

    const body = (await getJson<StatsResponse>(res))!;
    expect(body.leadsOwned).toBe(0);
    expect(body.leadsConverted).toBe(0);
    expect(body.campaignsOwned).toBe(0);
    expect(body.socialPostsOwned).toBe(0);
    expect(body.devTasksAssigned).toBe(0);
    expect(body.devTasksCompleted).toBe(0);
    expect(body.conversionRate).toBe(0);
    expect(body.attendanceLast30Days).toEqual({
      present: 0,
      leave: 0,
      wfh: 0,
      absent: 0,
    });
  });

  it('counts owned leads, converted leads, and computes conversionRate', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    // 3 leads owned by employee — 2 converted, 1 NEW.
    await prisma.lead.create({
      data: {
        name: 'Lead A',
        ownerId: employee.id,
        createdById: employee.id,
        status: 'CONVERTED',
      },
    });
    await prisma.lead.create({
      data: {
        name: 'Lead B',
        ownerId: employee.id,
        createdById: employee.id,
        status: 'CONVERTED',
      },
    });
    await prisma.lead.create({
      data: {
        name: 'Lead C',
        ownerId: employee.id,
        createdById: employee.id,
        status: 'NEW',
      },
    });
    // Distractor: lead owned by someone else.
    await prisma.lead.create({
      data: {
        name: 'Lead Z',
        ownerId: other.id,
        createdById: other.id,
        status: 'CONVERTED',
      },
    });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}/stats`),
      buildRouteContext(employee.id),
    );
    const body = (await getJson<StatsResponse>(res))!;
    expect(body.leadsOwned).toBe(3);
    expect(body.leadsConverted).toBe(2);
    // 2/3 ≈ 0.6666… — assert the math instead of comparing floats.
    expect(body.conversionRate).toBeCloseTo(2 / 3, 6);
  });

  it('counts campaigns, social posts, and dev tasks assigned/completed', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    await prisma.campaign.create({
      data: {
        name: 'Spring',
        channel: 'META_ADS',
        budget: 10_000,
        startDate: new Date('2026-01-01'),
        ownerId: employee.id,
      },
    });
    await prisma.socialPost.create({
      data: {
        platform: 'INSTAGRAM',
        caption: 'Hello world',
        ownerId: employee.id,
      },
    });
    await prisma.devTask.create({
      data: {
        title: 'Fix bug',
        type: 'BUG',
        status: 'DONE',
        assigneeId: employee.id,
        reporterId: employee.id,
      },
    });
    await prisma.devTask.create({
      data: {
        title: 'Build feature',
        type: 'FEATURE',
        status: 'DOING',
        assigneeId: employee.id,
        reporterId: employee.id,
      },
    });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}/stats`),
      buildRouteContext(employee.id),
    );
    const body = (await getJson<StatsResponse>(res))!;
    expect(body.campaignsOwned).toBe(1);
    expect(body.socialPostsOwned).toBe(1);
    expect(body.devTasksAssigned).toBe(2);
    expect(body.devTasksCompleted).toBe(1);
  });

  it('groups attendance into per-status counts within the 30-day window', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const today = new Date();
    // 3 present in-window, 1 leave in-window, 1 absent OUTSIDE the
    // 30-day window (must be excluded).
    const inWindow = [-1, -2, -3, -4].map((d) => addDays(today, d));
    await prisma.attendance.createMany({
      data: [
        { userId: employee.id, date: inWindow[0]!, status: 'present' },
        { userId: employee.id, date: inWindow[1]!, status: 'present' },
        { userId: employee.id, date: inWindow[2]!, status: 'present' },
        { userId: employee.id, date: inWindow[3]!, status: 'leave' },
        // 60 days ago — outside the 30-day window.
        {
          userId: employee.id,
          date: addDays(today, -60),
          status: 'absent',
        },
      ],
    });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}/stats`),
      buildRouteContext(employee.id),
    );
    const body = (await getJson<StatsResponse>(res))!;
    expect(body.attendanceLast30Days).toEqual({
      present: 3,
      leave: 1,
      wfh: 0,
      absent: 0,
    });
  });
});
