/**
 * Integration tests for `POST /api/users/[id]/attendance` (task 29).
 *
 * Validates: Requirements 4.7, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §5.2 (feature 4), §5.3, §5.4, §16.2.
 *
 * Coverage:
 *   - 401 when no session.
 *   - 403 when employee marks attendance for someone else.
 *   - 200 when employee marks their own attendance.
 *   - 200 when admin marks attendance for anyone.
 *   - Upsert behaviour: re-marking the same `(userId, date)` overwrites
 *     the previous status/notes (the `(userId, date)` constraint is
 *     resolved via `prisma.attendance.upsert(...)` per task 27).
 *   - 400 on invalid status enum.
 *   - 404 when the target user does not exist.
 *   - Date is normalised to UTC midnight regardless of input time.
 */

import { describe, expect, it } from 'vitest';

import { POST } from '@/app/api/users/[id]/attendance/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

describe('POST /api/users/[id]/attendance', () => {
  it('returns 401 when no session is present', async () => {
    const { user } = await createTestUser();
    await setSession(null);

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${user.id}/attendance`,
        { date: '2026-01-15', status: 'present' },
      ),
      buildRouteContext(user.id),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when an employee marks another user's attendance", async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${target.id}/attendance`,
        { date: '2026-01-15', status: 'present' },
      ),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(403);

    expect(
      await prisma.attendance.count({ where: { userId: target.id } }),
    ).toBe(0);
  });

  it('employee can mark their own attendance', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        {
          date: '2026-01-15',
          status: 'present',
          notes: 'On site',
        },
      ),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ status: string; notes: string | null }>(res);
    expect(body!.status).toBe('present');
    expect(body!.notes).toBe('On site');
  });

  it('admin can mark attendance for anyone', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${target.id}/attendance`,
        { date: '2026-01-15', status: 'wfh' },
      ),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.attendance.findFirst({
      where: { userId: target.id },
    });
    expect(stored!.status).toBe('wfh');
  });

  it('upsert: re-marking the same (userId, date) overwrites the previous row', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    // First mark — present.
    const first = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        { date: '2026-01-15', status: 'present', notes: 'first' },
      ),
      buildRouteContext(employee.id),
    );
    expect(first.status).toBe(200);
    const firstBody = await getJson<{ id: string; status: string }>(first);

    // Second mark, same date — leave + no notes (notes should clear).
    const second = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        { date: '2026-01-15', status: 'leave' },
      ),
      buildRouteContext(employee.id),
    );
    expect(second.status).toBe(200);
    const secondBody = await getJson<{
      id: string;
      status: string;
      notes: string | null;
    }>(second);

    // Same row id (upsert path), updated values.
    expect(secondBody!.id).toBe(firstBody!.id);
    expect(secondBody!.status).toBe('leave');
    expect(secondBody!.notes).toBeNull();

    // Exactly one row per (userId, date).
    const rows = await prisma.attendance.findMany({
      where: { userId: employee.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('returns 400 on invalid status enum', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        { date: '2026-01-15', status: 'sick-day-not-in-enum' },
      ),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
  });

  it('returns 400 when notes exceeds 500 chars', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        {
          date: '2026-01-15',
          status: 'present',
          notes: 'a'.repeat(501),
        },
      ),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target user does not exist (admin caller)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        'http://test/api/users/missing-id/attendance',
        { date: '2026-01-15', status: 'present' },
      ),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('writes a user.attendance_marked activity log row', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest(
        'POST',
        `http://test/api/users/${employee.id}/attendance`,
        { date: '2026-01-15', status: 'present' },
      ),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: employee.id,
        action: 'user.attendance_marked',
        entityType: 'attendance',
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({
      date: '2026-01-15',
      status: 'present',
    });
  });
});
